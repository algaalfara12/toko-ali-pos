// packages/api/src/routes/syncSales.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { Prisma } from "@prisma/client";

// ---------------- Helper tanggal (flex) ----------------
const ZDateOpt = z.preprocess((v) => {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}, z.date().optional());

// ---------------- Zod Schema (sejalan pos.ts) ----------------
const SaleLineInput = z.object({
  productId: z.string().uuid(),
  locationCode: z.string().min(1), // ⬅️ penting: per item lokasi sama seperti pos.ts
  uom: z.string().min(1),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  discount: z.number().nonnegative().optional().default(0),
});

const SalePaymentInput = z.object({
  method: z.enum(["CASH", "NON_CASH"]),
  amount: z.number().nonnegative(),
  ref: z.string().nullable().optional(),
});

const SalePushInput = z.object({
  clientDocId: z.string().min(1), // idempotensi
  id: z.string().uuid().optional(), // opsional: kalau client mau pakai id server

  cashierCode: z.string().min(1).optional().default("CASHIER"), // dipakai untuk nomor
  number: z.string().optional(), // jika kosong, server akan generate
  createdAt: ZDateOpt, // fleksibel (UTC ISO, offset, dsb)
  customerId: z.string().uuid().nullable().optional(),

  method: z.enum(["CASH", "NON_CASH"]).optional(), // opsional, server derive dari payments
  discountTotal: z.number().min(0).optional().default(0), // ⬅️ header-level discount, mirip pos.ts

  lines: z.array(SaleLineInput).min(1),
  payments: z.array(SalePaymentInput).min(1),
});

const PushSalesBody = z.object({
  sales: z.array(SalePushInput).min(1),
});

// ---------------- Helper TZ dan Nomor (sejalan pos.ts, lebih stabil TZ toko) ----------------
function localYmdParts(tz: string) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("id-ID", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => fmt.find((p) => p.type === type)?.value ?? "";
  return { Y: get("year"), M: get("month"), D: get("day") };
}

async function nextSaleNumber(cashierCode: string) {
  const sp = await prisma.storeProfile.findFirst({
    select: { timezone: true },
  });
  const tz = sp?.timezone || "Asia/Jakarta";
  const { Y, M, D } = localYmdParts(tz);

  const prefix = `TOKOAL-${Y}${M}${D}-${cashierCode}-`;
  const count = await prisma.sale.count({
    where: { number: { startsWith: prefix } },
  });
  const run = String(count + 1).padStart(4, "0");
  return `${prefix}${run}`;
}

// ---------------- Route ----------------
export default async function syncSalesRoutes(app: FastifyInstance) {
  app.post(
    "/sync/pushSales",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      // 1) x-device-id wajib
      const deviceId = String(req.headers["x-device-id"] || "").trim();
      if (!deviceId) {
        return reply
          .code(400)
          .send({ ok: false, error: "Missing x-device-id" });
      }

      // 2) SyncClient
      const ua =
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : undefined;
      const client = await prisma.syncClient.upsert({
        where: { deviceId },
        create: { deviceId, name: deviceId, userAgent: ua },
        update: { userAgent: ua },
      });

      // 3) parse body
      const pb = PushSalesBody.safeParse(req.body);
      if (!pb.success) {
        return reply.code(400).send({ ok: false, error: pb.error.flatten() });
      }
      const body = pb.data;

      // 4) user kasir dari JWT
      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      const cashierId = user?.id;

      // 5) summary
      const summary = {
        sales: { created: 0, duplicate: 0, errors: 0 },
      };

      // 6) loop setiap sale
      for (const sale of body.sales) {
        try {
          // === Idempotency: syncInbound cek clientDocId ===
          const inbound = await prisma.syncInbound.findUnique({
            where: {
              clientId_resource_clientDocId: {
                clientId: client.id,
                resource: "sale",
                clientDocId: sale.clientDocId,
              },
            } as any,
          });
          if (inbound) {
            summary.sales.duplicate++;
            continue;
          }

          // Kalau client kirim id server, cek dulu
          if (sale.id) {
            const found = await prisma.sale.findUnique({
              where: { id: sale.id },
            });
            if (found) {
              await prisma.syncInbound.create({
                data: {
                  clientId: client.id,
                  resource: "sale",
                  clientDocId: sale.clientDocId,
                  serverDocId: found.id,
                  status: "DUPLICATE",
                },
              });
              summary.sales.duplicate++;
              continue;
            }
          }

          // === VALIDASI customerId (opsional) ===
          const normalizedCustomerId =
            typeof sale.customerId === "string" && sale.customerId.trim() !== ""
              ? sale.customerId
              : null;

          if (normalizedCustomerId) {
            const exists = await prisma.customer.findUnique({
              where: { id: normalizedCustomerId },
            });
            if (!exists) {
              summary.sales.errors++;
              app.log.warn(
                { customerId: normalizedCustomerId },
                "sync-pushSales-customer-not-found"
              );
              continue;
            }
          }

          // === VALIDASI stok per item, UOM toBase, lokasi ===
          // - preload lokasi (code -> id)
          const locCodes = Array.from(
            new Set(sale.lines.map((l) => l.locationCode))
          );
          const locRows = await prisma.location.findMany({
            where: { code: { in: locCodes } },
            select: { id: true, code: true },
          });
          const locMap = new Map<string, string>(); // code -> id
          for (const r of locRows) locMap.set(r.code, r.id);

          for (const code of locCodes) {
            if (!locMap.has(code)) {
              summary.sales.errors++;
              app.log.warn({ code }, "sync-pushSales-location-not-found");
              continue;
            }
          }
          if (locMap.size !== locCodes.length) {
            // ada minimal satu lokasi tidak ditemukan → skip sale ini
            continue;
          }

          // - preload toBase UOM
          const productIds = Array.from(
            new Set(sale.lines.map((l) => l.productId))
          );
          const uomRows = await prisma.productUom.findMany({
            where: { productId: { in: productIds } },
            select: { productId: true, uom: true, toBase: true },
          });
          const toBaseMap = new Map<string, number>(); // key: `${productId}::${uom}`
          for (const r of uomRows)
            toBaseMap.set(`${r.productId}::${r.uom}`, r.toBase);
          const getTB = (pid: string, uom: string) =>
            toBaseMap.get(`${pid}::${uom}`);

          // - cek stok cukup
          const shortages: Array<{
            productId: string;
            locationCode: string;
            uom: string;
            needBase: number;
            haveBase: number;
          }> = [];

          for (const it of sale.lines) {
            const locationId = locMap.get(it.locationCode)!;
            const tbItem = getTB(it.productId, it.uom);
            if (!tbItem) {
              shortages.push({
                productId: it.productId,
                locationCode: it.locationCode,
                uom: it.uom,
                needBase: 0,
                haveBase: 0,
              });
              continue;
            }
            const needBase = it.qty * tbItem;
            // Aggregate stockMoves untuk product-lokasi
            const moves = await prisma.stockMove.findMany({
              where: { productId: it.productId, locationId },
              select: { qty: true, uom: true },
            });

            let haveBase = 0;
            for (const m of moves) {
              const tb = getTB(it.productId, m.uom);
              if (!tb) continue;
              haveBase += Number(m.qty) * tb;
            }

            if (haveBase + 1e-9 < needBase) {
              shortages.push({
                productId: it.productId,
                locationCode: it.locationCode,
                uom: it.uom,
                needBase,
                haveBase,
              });
            }
          }

          if (shortages.length) {
            // Konsisten dengan pos.ts (tapi di sini kita return error di summary)
            summary.sales.errors++;
            app.log.warn({ shortages }, "sync-pushSales-stock-not-enough");
            continue;
          }

          // === Hitung totals (mirip pos.ts) ===
          const subtotal = sale.lines.reduce(
            (s, it) => s + (it.qty * it.price - (it.discount ?? 0)),
            0
          );
          const total = Math.max(0, subtotal - (sale.discountTotal ?? 0));
          const paid = sale.payments.reduce((s, p) => s + p.amount, 0);
          const change = Math.max(0, paid - total);

          const method =
            sale.method ??
            (sale.payments.some((p) => p.method === "CASH")
              ? "CASH"
              : "NON_CASH");

          // createdAt server-side: pakai dari client bila ada
          const saleCreatedAt = sale.createdAt ?? new Date();

          // === Transaksi atomik ===
          const created = await prisma.$transaction(async (tx) => {
            // Generasi nomor (TZ aware, per kasir)
            const number =
              sale.number ?? (await nextSaleNumber(sale.cashierCode!));

            // Sale header
            const createdSale = await tx.sale.create({
              data: {
                id: sale.id, // boleh undefined
                number,
                cashierId,
                customerId: normalizedCustomerId,
                method,
                subtotal: new Prisma.Decimal(subtotal),
                discount: new Prisma.Decimal(sale.discountTotal ?? 0),
                tax: new Prisma.Decimal(0),
                total: new Prisma.Decimal(total),
                paid: new Prisma.Decimal(paid),
                change: new Prisma.Decimal(change),
                createdAt: saleCreatedAt,
              },
              select: { id: true },
            });

            // Lines + StockMoves
            for (const it of sale.lines) {
              const lineSubtotal = it.qty * it.price - (it.discount ?? 0);

              await tx.saleLine.create({
                data: {
                  saleId: createdSale.id,
                  productId: it.productId,
                  uom: it.uom,
                  qty: new Prisma.Decimal(it.qty),
                  price: new Prisma.Decimal(it.price),
                  discount: new Prisma.Decimal(it.discount ?? 0),
                  subtotal: new Prisma.Decimal(lineSubtotal),
                },
              });

              const locationId = locMap.get(it.locationCode)!;
              await tx.stockMove.create({
                data: {
                  productId: it.productId,
                  locationId,
                  qty: new Prisma.Decimal(-it.qty), // OUT
                  uom: it.uom,
                  type: "SALE",
                  refId: createdSale.id,
                  createdAt: saleCreatedAt,
                },
              });
            }

            // Payments
            for (const p of sale.payments) {
              await tx.payment.create({
                data: {
                  saleId: createdSale.id,
                  method: p.method,
                  kind: "SALE",
                  amount: new Prisma.Decimal(p.amount),
                  ref: p.ref ?? null,
                  createdAt: saleCreatedAt,
                },
              });
            }

            // Audit
            await tx.auditLog.create({
              data: {
                action: "SALE",
                actorId: cashierId,
                actorUsername: (req as any).user?.username ?? "unknown",
                entityType: "SALE",
                entityId: createdSale.id,
                refNumber: number,
                ip: String((req as any).ip || ""),
                payload: {
                  subtotal,
                  discountTotal: sale.discountTotal ?? 0,
                  total,
                  paid,
                  change,
                  lines: sale.lines.length,
                } as any,
              },
            });

            // Catat inbound idempotent
            await tx.syncInbound.create({
              data: {
                clientId: client.id,
                resource: "sale",
                clientDocId: sale.clientDocId,
                serverDocId: createdSale.id,
                status: "SUCCESS",
              },
            });

            return createdSale;
          });

          summary.sales.created++;
          app.log.info({ saleId: created.id }, "sync-pushSales-success");
        } catch (e) {
          summary.sales.errors++;
          app.log.error({ err: e }, "sync-pushSales-error");
        }
      }

      return reply.send({ ok: true, clientId: client.id, summary });
    }
  );
}
