import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { audit } from "../utils/audit"; // <-- ADD

// helper: rentang harian lokal
function dayRange(date = new Date()) {
  const start = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  );
  const end = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
  return { start, end };
}

// helper: buat nomor transaksi per-kasir per-hari
async function nextSaleNumber(cashierCode: string) {
  const { start, end } = dayRange();
  const countToday = await prisma.sale.count({
    where: {
      createdAt: { gte: start, lte: end },
      number: { startsWith: `TOKOAL-` },
    },
  });
  const running = (countToday + 1).toString().padStart(4, "0");
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `TOKOAL-${y}${m}${day}-${cashierCode}-${running}`;
}

export default async function posRoutes(app: FastifyInstance) {
  // GET /pos/price?productId=&uom=
  app.get(
    "/pos/price",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const q = req.query as any;
      if (!q.productId || !q.uom) {
        return reply
          .code(400)
          .send({ ok: false, error: "productId & uom wajib" });
      }
      const pl = await prisma.priceList.findFirst({
        where: {
          productId: String(q.productId),
          uom: String(q.uom),
          active: true,
        },
      });
      return reply.send({ ok: true, price: pl ? Number(pl.price) : null });
    }
  );

  // POST /pos/checkout
  app.post(
    "/pos/checkout",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const itemSchema = z.object({
        productId: z.string().uuid(),
        locationCode: z.string().min(1),
        uom: z.string().min(1),
        qty: z.number().positive(),
        price: z.number().nonnegative(),
        discount: z.number().min(0).optional().default(0),
      });
      const paySchema = z.object({
        method: z.enum(["CASH", "NON_CASH"]),
        amount: z.number().nonnegative(),
        ref: z.string().optional().nullable(),
      });
      const schema = z.object({
        cashierId: z.string().min(1),
        cashierCode: z.string().min(1),
        customerId: z.string().optional().nullable(),
        method: z.enum(["CASH", "NON_CASH"]),
        discountTotal: z.number().min(0).optional().default(0),
        items: z.array(itemSchema).min(1),
        payments: z.array(paySchema).min(1),
      });

      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const {
        cashierId,
        cashierCode,
        customerId,
        method,
        discountTotal,
        items,
        payments,
      } = p.data;

      // VALIDASI customerId (jika diisi)
      const normalizedCustomerId =
        typeof customerId === "string" && customerId.trim() !== ""
          ? customerId
          : null;

      if (normalizedCustomerId) {
        const exists = await prisma.customer.findUnique({
          where: { id: normalizedCustomerId },
        });
        if (!exists) {
          return reply.code(400).send({
            ok: false,
            error: `Customer tidak ditemukan: ${normalizedCustomerId}`,
          });
        }
      }

      // Pre-lookup lokasi & UOM & stok
      const locMap = new Map<string, string>();
      const shortages: Array<{
        productId: string;
        locationCode: string;
        need: number;
        have: number;
        uom: string;
      }> = [];

      // cache toBase per productId+uom
      const productIds = Array.from(new Set(items.map((i) => i.productId)));
      const uomRows = await prisma.productUom.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, uom: true, toBase: true },
      });
      const toBaseMap = new Map<string, number>(); // key: `${productId}::${uom}`
      for (const r of uomRows) {
        toBaseMap.set(`${r.productId}::${r.uom}`, r.toBase);
      }
      const getToBase = (productId: string, uom: string) => {
        const v = toBaseMap.get(`${productId}::${uom}`);
        return typeof v === "number" ? v : undefined;
      };

      for (const it of items) {
        if (!locMap.has(it.locationCode)) {
          const loc = await prisma.location.findUnique({
            where: { code: it.locationCode },
          });
          if (!loc)
            return reply.code(400).send({
              ok: false,
              error: `Lokasi tidak ditemukan: ${it.locationCode}`,
            });
          locMap.set(it.locationCode, loc.id);
        }
        const locationId = locMap.get(it.locationCode)!;

        const tbItem = getToBase(it.productId, it.uom);
        if (!tbItem)
          return reply.code(400).send({
            ok: false,
            error: `UOM ${it.uom} belum terdaftar pada produk`,
          });

        const needBase = it.qty * tbItem;

        const moves = await prisma.stockMove.findMany({
          where: { productId: it.productId, locationId },
          select: { qty: true, uom: true },
        });

        let haveBase = 0;
        for (const m of moves) {
          const tb = getToBase(it.productId, m.uom);
          if (!tb) continue;
          haveBase += Number(m.qty) * tb;
        }

        if (haveBase < needBase) {
          shortages.push({
            productId: it.productId,
            locationCode: it.locationCode,
            need: needBase,
            have: haveBase,
            uom: it.uom,
          });
        }
      }

      if (shortages.length) {
        return reply
          .code(400)
          .send({ ok: false, error: "Stok tidak cukup", shortages });
      }

      const subtotal = items.reduce(
        (s, it) => s + (it.qty * it.price - (it.discount ?? 0)),
        0
      );
      const total = Math.max(0, subtotal - (discountTotal ?? 0));
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      const change = Math.max(0, paid - total);

      // Transaksi atomik
      const sale = await prisma.$transaction(async (tx) => {
        const number = await nextSaleNumber(cashierCode);

        const sale = await tx.sale.create({
          data: {
            number,
            cashierId,
            customerId: normalizedCustomerId,
            method,
            subtotal,
            discount: discountTotal ?? 0,
            tax: 0,
            total,
            paid,
            change,
          },
        });

        for (const it of items) {
          await tx.saleLine.create({
            data: {
              saleId: sale.id,
              productId: it.productId,
              uom: it.uom,
              qty: it.qty,
              price: it.price,
              discount: it.discount ?? 0,
              subtotal: it.qty * it.price - (it.discount ?? 0),
            },
          });

          const locationId = locMap.get(it.locationCode)!;
          await tx.stockMove.create({
            data: {
              productId: it.productId,
              locationId,
              qty: -it.qty,
              uom: it.uom,
              type: "SALE",
              refId: sale.id,
            },
          });
        }

        for (const p of payments) {
          await tx.payment.create({
            data: {
              saleId: sale.id,
              method: p.method,
              amount: p.amount,
              ref: p.ref ?? null,
            },
          });
        }

        return sale;
      });

      // === AUDIT: SALE ===
      await audit(req, {
        action: "SALE",
        entityType: "SALE",
        entityId: sale.id,
        refNumber: sale.number,
        payload: {
          items,
          payments,
          subtotal,
          total,
          paid,
          change,
          customerId: normalizedCustomerId,
        },
      });

      return reply.send({
        ok: true,
        data: {
          id: sale.id,
          number: sale.number,
          total: Number(sale.total),
          paid: Number(sale.paid),
          change: Number(sale.change),
          createdAt: sale.createdAt,
        },
      });
    }
  );
}
