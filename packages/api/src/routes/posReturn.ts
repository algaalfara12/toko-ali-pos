// packages/api/src/routes/posReturn.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { audit } from "../utils/audit"; // <-- tetap
import { buildReturnReceiptPdf } from "../utils/pdf"; // <-- ADD

// util nomor retur
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
async function nextReturnNumber() {
  const { start, end } = dayRange();
  const count = await prisma.saleReturn.count({
    where: { createdAt: { gte: start, lte: end } },
  });
  const run = String(count + 1).padStart(4, "0");
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `RTN-${y}${m}${day}-${run}`;
}

// ===== Zod schemas =====
const itemSchema = z.object({
  productId: z.string().uuid(),
  uom: z.string().min(1),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
});
const refundSchema = z.object({
  method: z.enum(["CASH", "NON_CASH"]),
  amount: z.number().positive(),
  ref: z.string().optional(),
});
const createSchema = z.object({
  saleId: z.string().uuid(),
  cashierId: z.string().min(1),
  locationCode: z.string().min(1),
  reason: z.string().optional(),
  items: z.array(itemSchema).min(1),
  refunds: z.array(refundSchema).optional().default([]),
});

// ==== Helper: muat StoreProfile + logo (opsional) ====
async function loadStoreBrand() {
  const sp = await prisma.storeProfile.findFirst();
  const brand = {
    storeName: sp?.name ?? "TOKO ALI POS",
    storeAddress: sp?.address ?? undefined,
    storePhone: sp?.phone ?? undefined,
    storeFooterNote: sp?.footerNote ?? undefined,
    logoUrl: sp?.logoUrl ?? undefined,
    timezone: sp?.timezone ?? "Asia/Jakarta", // ← tambahkan timezone
  };

  let storeLogoBuffer: Buffer | undefined;
  if (brand.logoUrl) {
    try {
      const r = await fetch(brand.logoUrl);
      if (r.ok) {
        const arr = await r.arrayBuffer();
        storeLogoBuffer = Buffer.from(arr);
      }
    } catch {
      // abaikan error logo
    }
  }
  return { ...brand, storeLogoBuffer };
}

// helper format "YYYY-MM-DD HH:mm" sesuai timezone
function toLocalDateTimeLabel(d: Date, timeZone: string) {
  try {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    const fmt = new Intl.DateTimeFormat("id-ID", opts).formatToParts(d);
    const get = (type: string) => fmt.find((p) => p.type === type)?.value ?? "";
    const Y = get("year");
    const M = get("month");
    const D = get("day");
    const h = get("hour");
    const m = get("minute");
    return `${Y}-${M}-${D} ${h}:${m}`;
  } catch {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(
      2,
      "0"
    )}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

export default async function posReturnRoutes(app: FastifyInstance) {
  // POST /pos/returns
  app.post(
    "/pos/returns",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      const { saleId, cashierId, locationCode, reason, items, refunds } =
        parsed.data;

      const [sale, kasir, loc] = await Promise.all([
        prisma.sale.findUnique({
          where: { id: saleId },
          include: { lines: true },
        }),
        prisma.user.findUnique({ where: { id: cashierId } }),
        prisma.location.findUnique({ where: { code: locationCode } }),
      ]);
      if (!sale)
        return reply
          .code(404)
          .send({ ok: false, error: "Sale tidak ditemukan" });
      if (!kasir)
        return reply
          .code(400)
          .send({ ok: false, error: `Kasir tidak ditemukan: ${cashierId}` });
      if (!loc)
        return reply.code(400).send({
          ok: false,
          error: `Lokasi tidak ditemukan: ${locationCode}`,
        });

      const productIds = Array.from(new Set(items.map((i) => i.productId)));
      const uomRows = await prisma.productUom.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, uom: true, toBase: true },
      });
      const toBase = new Map<string, number>();
      for (const r of uomRows) toBase.set(`${r.productId}::${r.uom}`, r.toBase);
      const getTB = (pid: string, uom: string) => toBase.get(`${pid}::${uom}`);

      const soldMap = new Map<string, number>();
      for (const l of sale.lines) {
        const key = `${l.productId}::${l.uom}`;
        soldMap.set(key, (soldMap.get(key) ?? 0) + Number(l.qty));
      }

      const returnedRows = await prisma.saleReturnLine.findMany({
        where: { ret: { saleId } },
        select: { productId: true, uom: true, qty: true },
      });
      const returnedMap = new Map<string, number>();
      for (const r of returnedRows) {
        const key = `${r.productId}::${r.uom}`;
        returnedMap.set(key, (returnedMap.get(key) ?? 0) + Number(r.qty));
      }

      const violations: Array<{
        productId: string;
        uom: string;
        sold: number;
        alreadyReturned: number;
        tryReturn: number;
      }> = [];
      for (const it of items) {
        const key = `${it.productId}::${it.uom}`;
        const sold = soldMap.get(key) ?? 0;
        const already = returnedMap.get(key) ?? 0;
        const remain = sold - already;
        if (it.qty > remain + 1e-9) {
          violations.push({
            productId: it.productId,
            uom: it.uom,
            sold,
            alreadyReturned: already,
            tryReturn: it.qty,
          });
        }
        if (!getTB(it.productId, it.uom)) {
          return reply.code(400).send({
            ok: false,
            error: `UOM ${it.uom} belum terdaftar pada produk ${it.productId}`,
          });
        }
      }
      if (violations.length) {
        return reply.code(400).send({
          ok: false,
          error: "Qty retur melebihi qty jual",
          violations,
        });
      }

      const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);
      const refundTotal = (refunds ?? []).reduce((s, r) => s + r.amount, 0);

      const [sumPrevRefunds, sumPrevReturns] = await Promise.all([
        prisma.payment.aggregate({
          _sum: { amount: true },
          where: { kind: "REFUND", saleReturn: { saleId } },
        }),
        prisma.saleReturn.aggregate({
          _sum: { subtotal: true },
          where: { saleId },
        }),
      ]);
      const prevRefund = Number(sumPrevRefunds._sum.amount ?? 0);
      const prevReturnValue = Number(sumPrevReturns._sum.subtotal ?? 0);

      const newTotalRefund = prevRefund + refundTotal;
      const newTotalReturnValue = prevReturnValue + subtotal;
      const EPS = 1e-6;

      if (newTotalRefund > newTotalReturnValue + EPS) {
        return reply.code(400).send({
          ok: false,
          error: `Total refund kumulatif (${newTotalRefund}) melebihi nilai retur kumulatif (${newTotalReturnValue}) untuk sale ini.`,
          context: {
            prevRefund,
            prevReturnValue,
            thisRefund: refundTotal,
            thisReturn: subtotal,
            newTotalRefund,
            newTotalReturnValue,
          },
        });
      }

      const header = await prisma.$transaction(async (tx) => {
        const number = await nextReturnNumber();
        const created = await tx.saleReturn.create({
          data: {
            number,
            saleId,
            cashierId,
            locationId: loc.id,
            reason: reason ?? null,
            subtotal,
          },
        });

        for (const it of items) {
          await tx.saleReturnLine.create({
            data: {
              returnId: created.id,
              productId: it.productId,
              uom: it.uom,
              qty: it.qty,
              price: it.price,
              subtotal: it.qty * it.price,
            },
          });
          await tx.stockMove.create({
            data: {
              productId: it.productId,
              locationId: loc.id,
              qty: it.qty,
              uom: it.uom,
              type: "RETURN",
              refId: created.id,
            },
          });
        }

        if ((refunds ?? []).length) {
          await tx.payment.createMany({
            data: refunds!.map((r) => ({
              saleReturnId: created.id,
              method: r.method,
              kind: "REFUND",
              amount: r.amount,
              ref: r.ref ?? null,
            })),
          });
        }

        return created;
      });

      await audit(req, {
        action: "RETURN",
        entityType: "SALE_RETURN",
        entityId: header.id,
        refNumber: header.number,
        payload: {
          saleId,
          items,
          refunds,
          subtotal,
          refundTotal,
          locationCode,
          reason: reason ?? null,
        },
      });

      return reply.send({
        ok: true,
        data: {
          id: header.id,
          number: header.number,
          subtotal: Number(subtotal),
          refundTotal,
        },
      });
    }
  );

  // GET /pos/returns/:id  (JSON lama) + (BARU) export=pdf → Nota Retur dgn RBAC & TZ
  app.get(
    "/pos/returns/:id",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (req, reply) => {
      const Q = z.object({
        export: z.string().optional(),
        paper: z.enum(["58", "80", "A6"]).optional(),
      });
      const pq = Q.safeParse(req.query);
      if (!pq.success) {
        return reply.code(400).send({ ok: false, error: pq.error.flatten() });
      }
      const exportFmt = (pq.data.export ?? "").toLowerCase();
      const paper = pq.data.paper ?? "A6";

      const id = String((req.params as any).id);
      const ret = await prisma.saleReturn.findUnique({
        where: { id },
        include: {
          location: { select: { code: true, name: true } },
          sale: {
            select: {
              number: true,
              createdAt: true,
              customer: { select: { name: true, memberCode: true } },
            },
          },
          cashier: { select: { id: true, username: true } }, // <— penting
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
          payments: true,
        },
      });
      if (!ret)
        return reply
          .code(404)
          .send({ ok: false, error: "Return tidak ditemukan" });

      // ✅ RBAC: kasir hanya boleh unduh retur yang DIA buat
      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      if (user.role === "kasir" && ret.cashierId !== user.id) {
        return reply.code(403).send({ ok: false, error: "Forbidden" });
      }

      const refundTotal = ret.payments
        .filter((p) => p.kind === "REFUND")
        .reduce((s, p) => s + Number(p.amount), 0);

      if (exportFmt === "pdf") {
        const brand = await loadStoreBrand();
        const tz = brand.timezone || "Asia/Jakarta";

        const items = ret.lines.map((l) => ({
          sku: l.product?.sku ?? null,
          name: l.product?.name ?? "",
          uom: l.uom,
          qty: Number(l.qty),
          price: Number(l.price),
          subtotal: Number(l.subtotal),
        }));
        const refunds = ret.payments
          .filter((p) => p.kind === "REFUND")
          .map((p) => ({
            method: p.method as "CASH" | "NON_CASH",
            amount: Number(p.amount),
            ref: p.ref ?? null,
          }));

        const buf = await buildReturnReceiptPdf({
          storeName: brand.storeName,
          storeAddress: brand.storeAddress,
          storePhone: brand.storePhone,
          storeFooterNote: brand.storeFooterNote,
          storeLogoBuffer: brand.storeLogoBuffer,

          returnNumber: ret.number,
          returnDateTime: ret.createdAt,
          returnDateTimeLabel: toLocalDateTimeLabel(ret.createdAt, tz),

          saleNumber: ret.sale?.number ?? null,
          saleDateTime: ret.sale?.createdAt ?? null,
          saleDateTimeLabel: ret.sale?.createdAt
            ? toLocalDateTimeLabel(ret.sale.createdAt, tz)
            : undefined,

          // ✅ pakai nama kasir pembuat retur
          cashierUsername: ret.cashier?.username ?? user.username,

          customerName: ret.sale?.customer?.name ?? null,
          customerCode: ret.sale?.customer?.memberCode ?? null,

          items,
          refunds,
          subtotalReturn: Number(ret.subtotal),
          refundTotal,
          paper,
        } as any);

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="return_${ret.number}.pdf"`
        );
        return reply.send(buf);
      }

      // JSON tetap
      return reply.send({
        ok: true,
        data: {
          id: ret.id,
          number: ret.number,
          sale: ret.sale,
          location: ret.location,
          subtotal: Number(ret.subtotal),
          refundTotal,
          createdAt: ret.createdAt,
          lines: ret.lines.map((l) => ({
            productId: l.productId,
            sku: l.product.sku,
            name: l.product.name,
            uom: l.uom,
            qty: Number(l.qty),
            price: Number(l.price),
            subtotal: Number(l.subtotal),
          })),
          refunds: ret.payments
            .filter((p) => p.kind === "REFUND")
            .map((p) => ({
              id: p.id,
              method: p.method,
              amount: Number(p.amount),
              ref: p.ref ?? null,
              createdAt: p.createdAt,
            })),
        },
      });
    }
  );

  // GET /pos/returns (list) — tidak diubah
  app.get(
    "/pos/returns",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (_req, reply) => {
      const rows = await prisma.saleReturn.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          location: { select: { code: true, name: true } },
          sale: { select: { number: true } },
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
          payments: true,
        },
      });

      return reply.send({
        ok: true,
        data: rows.map((r) => {
          const refundTotal = r.payments
            .filter((p) => p.kind === "REFUND")
            .reduce((s, p) => s + Number(p.amount), 0);
          return {
            id: r.id,
            number: r.number,
            saleNumber: r.sale.number,
            location: r.location,
            subtotal: Number(r.subtotal),
            refundTotal,
            createdAt: r.createdAt,
            items: r.lines.map((l) => ({
              productId: l.productId,
              sku: l.product.sku,
              name: l.product.name,
              uom: l.uom,
              qty: Number(l.qty),
              price: Number(l.price),
              subtotal: Number(l.subtotal),
            })),
          };
        }),
      });
    }
  );
}
