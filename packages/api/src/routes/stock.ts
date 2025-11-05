import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { audit } from "../utils/audit"; // <-- ADD

// === Helpers ===

// Load semua UOM->toBase utk 1 product sekali saja
async function loadUomMap(productId: string) {
  const rows = await prisma.productUom.findMany({
    where: { productId },
    select: { uom: true, toBase: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.uom, Number(r.toBase));
  return map;
}

// Konversi qty ke base pakai map (tanpa query ulang)
function toBaseQtyWithMap(
  uomMap: Map<string, number>,
  uom: string,
  qty: number
) {
  const tb = uomMap.get(uom);
  if (!tb) throw new Error(`UOM ${uom} belum terdaftar pada produk`);
  return tb * qty;
}

export default async function stockRoutes(app: FastifyInstance) {
  // 1) Barang Masuk (IN) — single item
  app.post(
    "/stock/in",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const schema = z.object({
        productId: z.string().uuid(),
        locationCode: z.string().min(1),
        qty: z.number().positive(),
        uom: z.string().min(1),
        refId: z.string().optional(),
      });

      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const { productId, locationCode, qty, uom, refId } = p.data;

      const loc = await prisma.location.findUnique({
        where: { code: locationCode },
      });
      if (!loc)
        return reply
          .code(404)
          .send({ ok: false, error: "Lokasi tidak ditemukan" });

      const uomOk = await prisma.productUom.findFirst({
        where: { productId, uom },
      });
      if (!uomOk)
        return reply
          .code(400)
          .send({ ok: false, error: "UOM belum terdaftar pada produk" });

      const move = await prisma.stockMove.create({
        data: {
          productId,
          locationId: loc.id,
          qty,
          uom,
          type: "IN",
          refId: refId ?? null,
        },
      });

      // === AUDIT: ADJUSTMENT (manual stock IN) ===
      await audit(req, {
        action: "ADJUSTMENT",
        entityType: "STOCK_MOVE",
        entityId: move.id,
        refNumber: refId ?? null,
        payload: {
          productId,
          locationCode,
          qty,
          uom,
          type: "IN",
        },
      });

      return reply.send({ ok: true, data: move });
    }
  );

  // 2) /stock/balance
  app.get(
    "/stock/balance",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      try {
        const q = req.query as any;
        const productId = String(q.productId ?? "");
        const locationCode = String(q.locationCode ?? "");
        const outUom = q.uom ? String(q.uom) : null;

        if (!productId || !locationCode) {
          return reply
            .code(400)
            .send({ ok: false, error: "productId & locationCode wajib" });
        }

        const loc = await prisma.location.findUnique({
          where: { code: locationCode },
        });
        if (!loc)
          return reply.code(404).send({
            ok: false,
            error: `Lokasi tidak ditemukan: ${locationCode}`,
          });

        const [moves, uomMap] = await Promise.all([
          prisma.stockMove.findMany({
            where: { productId, locationId: loc.id },
            orderBy: { createdAt: "asc" },
            select: { qty: true, uom: true },
          }),
          loadUomMap(productId),
        ]);

        let balanceBase = 0;
        for (const m of moves) {
          balanceBase += toBaseQtyWithMap(uomMap, m.uom, Number(m.qty));
        }

        let balanceInUom: number | undefined;
        if (outUom) {
          const tb = uomMap.get(outUom);
          if (!tb)
            return reply.code(400).send({
              ok: false,
              error: `UOM ${outUom} belum terdaftar pada produk`,
            });
          balanceInUom = balanceBase / tb;
        }

        return reply.send({
          ok: true,
          data: {
            productId,
            locationCode,
            balanceBase,
            ...(outUom ? { uom: outUom, balanceInUom } : {}),
          },
        });
      } catch (err: any) {
        req.log.error(err);
        return reply
          .code(500)
          .send({ ok: false, error: err?.message ?? "Internal error" });
      }
    }
  );

  // 3) /stock/transfer
  app.post(
    "/stock/transfer",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const b = req.body as any;
      try {
        const productId = String(b.productId);
        const fromCode = String(b.fromLocationCode);
        const toCode = String(b.toLocationCode);
        const uom = String(b.uom);
        const qty = Number(b.qty);
        const refId = b.refId ? String(b.refId) : null;

        if (!productId || !fromCode || !toCode || !uom || !(qty > 0)) {
          return reply
            .code(400)
            .send({ ok: false, error: "Param tidak lengkap / qty harus > 0" });
        }
        if (fromCode === toCode) {
          return reply.code(400).send({
            ok: false,
            error: "Lokasi asal dan tujuan tidak boleh sama",
          });
        }

        const [fromLoc, toLoc] = await Promise.all([
          prisma.location.findUnique({ where: { code: fromCode } }),
          prisma.location.findUnique({ where: { code: toCode } }),
        ]);
        if (!fromLoc)
          return reply.code(400).send({
            ok: false,
            error: `Lokasi asal tidak ditemukan: ${fromCode}`,
          });
        if (!toLoc)
          return reply.code(400).send({
            ok: false,
            error: `Lokasi tujuan tidak ditemukan: ${toCode}`,
          });

        const uomMap = await loadUomMap(productId);
        const tbItem = uomMap.get(uom);
        if (!tbItem)
          return reply.code(400).send({
            ok: false,
            error: `UOM ${uom} belum terdaftar pada produk`,
          });

        const needBase = qty * tbItem;

        const movesFrom = await prisma.stockMove.findMany({
          where: { productId, locationId: fromLoc.id },
          select: { qty: true, uom: true },
        });
        let haveBase = 0;
        for (const m of movesFrom) {
          haveBase += toBaseQtyWithMap(uomMap, m.uom, Number(m.qty));
        }

        if (haveBase + 1e-9 < needBase) {
          return reply.code(400).send({
            ok: false,
            error: `Stok tidak cukup di ${fromCode}. Sisa (base): ${haveBase}, butuh (base): ${needBase}`,
          });
        }

        const result = await prisma.$transaction(async (tx) => {
          const outMove = await tx.stockMove.create({
            data: {
              productId,
              locationId: fromLoc.id,
              qty: -qty,
              uom,
              type: "TRANSFER",
              refId,
            },
          });

          const inMove = await tx.stockMove.create({
            data: {
              productId,
              locationId: toLoc.id,
              qty: qty,
              uom,
              type: "TRANSFER",
              refId,
            },
          });

          return { outMove, inMove };
        });

        // === AUDIT: TRANSFER ===
        await audit(req, {
          action: "TRANSFER",
          entityType: "STOCK_TRANSFER",
          entityId: result.outMove.id,
          refNumber: refId ?? null,
          payload: {
            productId,
            fromLocationCode: fromCode,
            toLocationCode: toCode,
            uom,
            qty,
            outMoveId: result.outMove.id,
            inMoveId: result.inMove.id,
          },
        });

        return reply.send({ ok: true, data: result });
      } catch (err: any) {
        req.log.error(err);
        return reply
          .code(500)
          .send({ ok: false, error: err?.message ?? "Internal error" });
      }
    }
  );

  // 4) /stock/adjust (+/-)
  app.post(
    "/stock/adjust",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const schema = z.object({
        productId: z.string().uuid(),
        locationCode: z.string().min(1),
        uom: z.string().min(1),
        qty: z.number().refine((v) => v !== 0, "qty tidak boleh 0"),
        refId: z.string().optional(),
      });

      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const { productId, locationCode, uom, qty, refId } = p.data;

      const loc = await prisma.location.findUnique({
        where: { code: locationCode },
      });
      if (!loc)
        return reply
          .code(404)
          .send({ ok: false, error: "Lokasi tidak ditemukan" });

      const uomOk = await prisma.productUom.findFirst({
        where: { productId, uom },
      });
      if (!uomOk)
        return reply
          .code(400)
          .send({ ok: false, error: `UOM ${uom} belum terdaftar pada produk` });

      const move = await prisma.stockMove.create({
        data: {
          productId,
          locationId: loc.id,
          qty,
          uom,
          type: "ADJUSTMENT",
          refId: refId ?? null,
        },
      });

      // === AUDIT: ADJUSTMENT ===
      await audit(req, {
        action: "ADJUSTMENT",
        entityType: "STOCK_MOVE",
        entityId: move.id,
        refNumber: refId ?? null,
        payload: { productId, locationCode, uom, qty, type: "ADJUSTMENT" },
      });

      return reply.send({ ok: true, data: move });
    }
  );

  // 5) /stock/balance-by-uom
  app.get(
    "/stock/balance-by-uom",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      try {
        const q = req.query as any;
        const productId = String(q.productId ?? "");
        const locationCode = String(q.locationCode ?? "");
        if (!productId || !locationCode) {
          return reply
            .code(400)
            .send({ ok: false, error: "productId & locationCode wajib" });
        }
        const loc = await prisma.location.findUnique({
          where: { code: locationCode },
        });
        if (!loc)
          return reply.code(404).send({
            ok: false,
            error: `Lokasi tidak ditemukan: ${locationCode}`,
          });

        const rows = await prisma.stockMove.groupBy({
          by: ["uom"],
          where: { productId, locationId: loc.id },
          _sum: { qty: true },
        });

        const data = rows.map((r) => ({
          uom: r.uom,
          qty: Number(r._sum.qty ?? 0),
        }));
        return reply.send({ ok: true, productId, locationCode, data });
      } catch (err: any) {
        req.log.error(err);
        return reply
          .code(500)
          .send({ ok: false, error: err?.message ?? "Internal error" });
      }
    }
  );
}
