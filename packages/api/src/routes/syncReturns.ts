// packages/api/src/routes/syncReturns.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { audit } from "../utils/audit";

// ---------- Helper: tanggal opsional (sama dengan syncSales) ----------
const ZDateOpt = z.preprocess((v) => {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}, z.date().optional());

// ---------- Nomor retur (sama dengan posReturn.ts) ----------
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

// ---------- Zod schema input ----------
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

const ReturnPushInput = z.object({
  clientDocId: z.string().min(1), // idempotensi
  saleId: z.string().uuid(),
  locationCode: z.string().min(1),
  reason: z.string().optional(),

  createdAt: ZDateOpt, // ⬅️ NEW: sama seperti syncSales (pakai bila ada)

  items: z.array(itemSchema).min(1),
  refunds: z.array(refundSchema).optional().default([]),
});

const PushReturnsBody = z.object({
  returns: z.array(ReturnPushInput).min(1),
});

export default async function syncReturnsRoutes(app: FastifyInstance) {
  app.post(
    "/sync/pushReturns",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      // x-device-id wajib
      const deviceId = String(req.headers["x-device-id"] || "").trim();
      if (!deviceId) {
        return reply
          .code(400)
          .send({ ok: false, error: "Missing x-device-id" });
      }
      // SyncClient
      const ua =
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : undefined;
      const client = await prisma.syncClient.upsert({
        where: { deviceId },
        create: { deviceId, name: deviceId, userAgent: ua },
        update: { userAgent: ua },
      });

      // parse body
      const pb = PushReturnsBody.safeParse(req.body);
      if (!pb.success) {
        return reply.code(400).send({ ok: false, error: pb.error.flatten() });
      }
      const body = pb.data;

      // user
      const user = (req as any).user as {
        id: string;
        username: string;
        role: string;
      };
      const cashierId = user.id;

      const summary = { returns: { created: 0, duplicate: 0, errors: 0 } };

      for (const r of body.returns) {
        try {
          // === Idempotensi via SyncInbound ===
          const inbound = await prisma.syncInbound.findUnique({
            where: {
              clientId_resource_clientDocId: {
                clientId: client.id,
                resource: "saleReturn",
                clientDocId: r.clientDocId,
              },
            } as any,
          });
          if (inbound) {
            summary.returns.duplicate++;
            continue;
          }

          // === Load sale + lokasi yang dipakai untuk stockMove RETURN ===
          const [sale, loc] = await Promise.all([
            prisma.sale.findUnique({
              where: { id: r.saleId },
              include: { lines: true },
            }),
            prisma.location.findUnique({ where: { code: r.locationCode } }),
          ]);
          if (!sale) throw new Error("Sale tidak ditemukan");
          if (!loc)
            throw new Error(`Lokasi tidak ditemukan: ${r.locationCode}`);

          // === Validasi UOM + hitung batas retur yang diizinkan (mirip posReturn.ts) ===
          // 1) cek UOM ada
          const productIds = Array.from(
            new Set(r.items.map((i) => i.productId))
          );
          const uomRows = await prisma.productUom.findMany({
            where: { productId: { in: productIds } },
            select: { productId: true, uom: true },
          });
          const uomSet = new Set(
            uomRows.map((x) => `${x.productId}::${x.uom}`)
          );
          for (const it of r.items) {
            if (!uomSet.has(`${it.productId}::${it.uom}`)) {
              throw new Error(
                `UOM ${it.uom} belum terdaftar pada produk ${it.productId}`
              );
            }
          }

          // 2) hitung sold per productId+uom
          const soldMap = new Map<string, number>();
          for (const l of sale.lines) {
            const key = `${l.productId}::${l.uom}`;
            soldMap.set(key, (soldMap.get(key) ?? 0) + Number(l.qty));
          }

          // 3) hitung yang sudah diretur sebelumnya
          const prevReturns = await prisma.saleReturnLine.findMany({
            where: { ret: { saleId: r.saleId } },
            select: { productId: true, uom: true, qty: true },
          });
          const returnedMap = new Map<string, number>();
          for (const rr of prevReturns) {
            const key = `${rr.productId}::${rr.uom}`;
            returnedMap.set(key, (returnedMap.get(key) ?? 0) + Number(rr.qty));
          }

          // 4) cek over-return
          const violations: Array<{
            productId: string;
            uom: string;
            sold: number;
            alreadyReturned: number;
            tryReturn: number;
          }> = [];
          for (const it of r.items) {
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
          }
          if (violations.length) {
            throw Object.assign(new Error("Qty retur melebihi qty jual"), {
              violations,
            });
          }

          const subtotal = r.items.reduce((s, it) => s + it.qty * it.price, 0);
          const refundTotal = (r.refunds ?? []).reduce(
            (s, rf) => s + rf.amount,
            0
          );

          // === gunakan createdAt dari client jika ada (sama seperti syncSales) ===
          const createdAt = r.createdAt ?? new Date();

          // === Transaksi: tulis header, line, stockMove RETURN (qty +), payment REFUND ===
          const header = await prisma.$transaction(async (tx) => {
            const number = await nextReturnNumber();

            const created = await tx.saleReturn.create({
              data: {
                number,
                saleId: r.saleId,
                cashierId,
                locationId: loc.id,
                reason: r.reason ?? null,
                subtotal,
                createdAt, // ⬅️ PENTING: createdAt pakai client bila ada
              },
            });

            for (const it of r.items) {
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
                  qty: it.qty, // RETURN = IN (positif)
                  uom: it.uom,
                  type: "RETURN",
                  refId: created.id,
                  createdAt, // ⬅️ sejajarkan waktu stockMove
                },
              });
            }

            if ((r.refunds ?? []).length) {
              for (const rf of r.refunds!) {
                await tx.payment.create({
                  data: {
                    saleReturnId: created.id,
                    method: rf.method,
                    kind: "REFUND",
                    amount: rf.amount,
                    ref: rf.ref ?? null,
                    createdAt, // ⬅️ sejajarkan waktu payment REFUND
                  },
                });
              }
            }

            // catat inbound idempoten
            await tx.syncInbound.create({
              data: {
                clientId: client.id,
                resource: "saleReturn",
                clientDocId: r.clientDocId,
                serverDocId: created.id,
                status: "SUCCESS",
              },
            });

            return created;
          });

          // Audit (non-blocking)
          try {
            await audit(req, {
              action: "RETURN",
              entityType: "SALE_RETURN",
              entityId: header.id,
              refNumber: header.number,
              payload: {
                saleId: r.saleId,
                locationCode: r.locationCode,
                reason: r.reason ?? null,
                items: r.items,
                refunds: r.refunds ?? [],
                subtotal,
                refundTotal,
              },
            });
          } catch (_e) {}

          summary.returns.created++;
          app.log.info({ id: header.id }, "sync-pushReturns-success");
        } catch (e) {
          summary.returns.errors++;
          app.log.error({ err: e }, "sync-pushReturns-error");
        }
      }

      return reply.send({ ok: true, summary });
    }
  );
}
