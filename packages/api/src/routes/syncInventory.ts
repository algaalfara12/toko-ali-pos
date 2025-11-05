// packages/api/src/routes/syncInventory.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { Prisma } from "@prisma/client";

// Reuse helper tanggal opsional
const ZDateOpt = z.preprocess((v) => {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}, z.date().optional());

// =====================
// Helpers nomor existing
// =====================

function nextRepackNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  // simple sequence by timestamp (seragam dg repack.ts Anda)
  return `RPK-${y}${m}${dd}-${Date.now().toString().slice(-6)}`;
}

async function nextPurchaseNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const dateTag = `${y}${m}${day}`;

  const start = new Date(y, d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(y, d.getMonth(), d.getDate(), 23, 59, 59, 999);

  const countToday = await prisma.purchase.count({
    where: { createdAt: { gte: start, lte: end } },
  });
  const running = String(countToday + 1).padStart(4, "0");
  return `PO-${dateTag}-${running}`;
}

// UOM check
async function ensureUomExists(productId: string, uom: string) {
  const u = await prisma.productUom.findFirst({ where: { productId, uom } });
  if (!u) throw new Error(`UOM ${uom} belum terdaftar pada produk`);
  return u;
}

// =============================
// Zod schema untuk PUSH Purchase
// =============================
const PurchaseLinePush = z.object({
  productId: z.string().uuid(),
  uom: z.string().min(1),
  qty: z.number().positive(),
  buyPrice: z.number().nonnegative(),
  sellPrice: z.number().nonnegative().optional().nullable(),
});

const SupplierObj = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
});

const PurchasePush = z.object({
  clientDocId: z.string().min(1),
  id: z.string().uuid().optional(),
  number: z.string().optional(),
  createdAt: ZDateOpt,

  // lokasi wajib
  locationCode: z.string().min(1),

  // supplier optional: pilih salah satu
  supplierId: z.string().uuid().optional().nullable(),
  supplier: SupplierObj.optional().nullable(),

  discount: z.number().nonnegative().optional().default(0),
  lines: z.array(PurchaseLinePush).min(1),
});

const PushPurchasesBody = z.object({
  purchases: z.array(PurchasePush).min(1),
});

// =======================
// Zod schema PUSH Repack
// =======================
const RepackIO = z.object({
  productId: z.string().uuid(),
  uom: z.string().min(1),
  qty: z.number().positive(),
});

const RepackPush = z.object({
  clientDocId: z.string().min(1),
  id: z.string().uuid().optional(), // jika mau pertahankan id server (opsional)
  number: z.string().optional(),
  createdAt: ZDateOpt,
  notes: z.string().optional().nullable(),
  extraCost: z.number().nonnegative().optional().default(0),

  // opsional: override lokasi proses repack; jika tidak ada => "GUDANG" (sesuai repack.ts)
  locationCode: z.string().optional().nullable(),

  inputs: z.array(RepackIO).min(1),
  outputs: z.array(RepackIO).min(1),
});

const PushRepackBody = z.object({
  repacks: z.array(RepackPush).min(1),
});

// ========================
// Zod schema PUSH Transfer
// ========================
const TransferPush = z.object({
  clientDocId: z.string().min(1),
  // tidak ada header id karena transfer hanya 2 stockMove
  createdAt: ZDateOpt,

  productId: z.string().uuid(),
  fromLocationCode: z.string().min(1),
  toLocationCode: z.string().min(1),
  uom: z.string().min(1),
  qty: z.number().positive(),
  refId: z.string().optional().nullable(), // opsional
});

const PushTransfersBody = z.object({
  transfers: z.array(TransferPush).min(1),
});

const AdjustmentPush = z.object({
  clientDocId: z.string().min(1),
  productId: z.string().uuid(),
  locationCode: z.string().min(1),
  uom: z.string().min(1),
  qty: z.number().refine((v) => v !== 0, "qty tidak boleh 0"),
  createdAt: ZDateOpt,
  refId: z.string().optional().nullable(),
});
const PushAdjustmentsBody = z.object({
  adjustments: z.array(AdjustmentPush).min(1),
});

export default async function syncInventoryRoutes(app: FastifyInstance) {
  // Common guard: x-device-id + SyncClient
  async function ensureClient(req: any) {
    const deviceId = String(req.headers["x-device-id"] || "").trim();
    if (!deviceId) {
      throw Object.assign(new Error("Missing x-device-id"), { code: 400 });
    }
    const ua =
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : undefined;

    const client = await prisma.syncClient.upsert({
      where: { deviceId },
      create: { deviceId, name: deviceId, userAgent: ua },
      update: { userAgent: ua },
    });
    return client;
  }

  // ================
  // /sync/pushPurchases
  // ================
  app.post(
    "/sync/pushPurchases",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      let client: any;
      try {
        client = await ensureClient(req);
      } catch (e: any) {
        const code = e.code || 400;
        return reply.code(code).send({ ok: false, error: e.message });
      }

      const parsed = PushPurchasesBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      }
      const body = parsed.data;

      const summary = { created: 0, duplicate: 0, errors: 0 };

      for (const doc of body.purchases) {
        try {
          // idempoten
          const existInbound = await prisma.syncInbound.findUnique({
            where: {
              clientId_resource_clientDocId: {
                clientId: client.id,
                resource: "purchase",
                clientDocId: doc.clientDocId,
              },
            } as any,
          });
          if (existInbound) {
            summary.duplicate++;
            continue;
          }

          if (doc.id) {
            const exist = await prisma.purchase.findUnique({
              where: { id: doc.id },
            });
            if (exist) {
              await prisma.syncInbound.create({
                data: {
                  clientId: client.id,
                  resource: "purchase",
                  clientDocId: doc.clientDocId,
                  serverDocId: exist.id,
                  status: "DUPLICATE",
                },
              });
              summary.duplicate++;
              continue;
            }
          }

          // lokasi
          const loc = await prisma.location.findUnique({
            where: { code: doc.locationCode },
          });
          if (!loc)
            throw new Error(`Lokasi tidak ditemukan: ${doc.locationCode}`);

          // tentukan supplier
          let supplierId: string | null = null;
          if (doc.supplierId) {
            supplierId = doc.supplierId;
          } else if (doc.supplier?.name) {
            const name = doc.supplier.name;
            const phone = doc.supplier.phone ?? undefined;
            const address = doc.supplier.address ?? undefined;
            if (phone) {
              const sup = await prisma.supplier.upsert({
                where: { phone },
                create: { name, phone, address },
                update: { name, address },
              });
              supplierId = sup.id;
            } else {
              const sup = await prisma.supplier.create({
                data: { name, phone: null, address },
              });
              supplierId = sup.id;
            }
          }

          // hitung subtotal, discount, total
          let subtotal = 0;
          for (const l of doc.lines) {
            const qty = l.qty;
            const buy = l.buyPrice;
            if (!(qty > 0) || !(buy >= 0)) {
              throw new Error(
                "qty harus > 0 & buyPrice >= 0 pada setiap baris"
              );
            }
            subtotal += qty * buy;
          }
          const discount = doc.discount ?? 0;
          const total = subtotal - discount;

          const createdAt = doc.createdAt ?? new Date();
          const number = doc.number ?? (await nextPurchaseNumber());

          const created = await prisma.$transaction(async (tx) => {
            const header = await tx.purchase.create({
              data: {
                id: doc.id, // boleh undefined
                number,
                supplierId,
                locationId: loc.id,
                subtotal,
                discount,
                total,
                createdAt,
              },
            });

            for (const l of doc.lines) {
              const productId = l.productId;
              const uom = l.uom;

              const okUom = await tx.productUom.findFirst({
                where: { productId, uom },
                select: { id: true },
              });
              if (!okUom) {
                throw new Error(
                  `UOM ${uom} belum terdaftar untuk produk ${productId}`
                );
              }

              await tx.purchaseLine.create({
                data: {
                  purchaseId: header.id,
                  productId,
                  uom,
                  qty: l.qty,
                  buyPrice: l.buyPrice,
                  sellPrice: l.sellPrice ?? null,
                  subtotal: l.qty * l.buyPrice,
                },
              });

              await tx.stockMove.create({
                data: {
                  productId,
                  locationId: loc.id,
                  qty: l.qty, // IN
                  uom,
                  type: "IN",
                  refId: header.id,
                  createdAt,
                },
              });

              if (l.sellPrice != null) {
                const existing = await tx.priceList.findFirst({
                  where: { productId, uom, active: true },
                  orderBy: { updatedAt: "desc" as any },
                });
                if (existing) {
                  await tx.priceList.update({
                    where: { id: existing.id },
                    data: { price: l.sellPrice },
                  });
                } else {
                  await tx.priceList.create({
                    data: { productId, uom, price: l.sellPrice, active: true },
                  });
                }
              }
            }

            await tx.syncInbound.create({
              data: {
                clientId: client.id,
                resource: "purchase",
                clientDocId: doc.clientDocId,
                serverDocId: header.id,
                status: "SUCCESS",
              },
            });

            return header;
          });

          summary.created++;
          app.log.info(
            { purchaseId: created.id },
            "sync-pushPurchases-success"
          );
        } catch (e) {
          summary.errors++;
          app.log.error({ err: e }, "sync-pushPurchases-error");
        }
      }

      return reply.send({ ok: true, clientId: client.id, summary });
    }
  );

  // ================
  // /sync/pushRepack
  // ================
  app.post(
    "/sync/pushRepack",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      let client: any;
      try {
        client = await ensureClient(req);
      } catch (e: any) {
        return reply.code(e.code || 400).send({ ok: false, error: e.message });
      }

      const parsed = PushRepackBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      }
      const body = parsed.data;

      const summary = { created: 0, duplicate: 0, errors: 0 };

      // lokasi default untuk repack: "GUDANG" (sesuai repack.ts Anda)
      async function resolveRepackLocation(code?: string | null) {
        const c = code?.trim() || "GUDANG";
        const loc = await prisma.location.findUnique({ where: { code: c } });
        if (!loc) throw new Error(`Lokasi repack tidak ditemukan: ${c}`);
        return loc.id;
      }

      for (const doc of body.repacks) {
        try {
          const existInbound = await prisma.syncInbound.findUnique({
            where: {
              clientId_resource_clientDocId: {
                clientId: client.id,
                resource: "repack",
                clientDocId: doc.clientDocId,
              },
            } as any,
          });
          if (existInbound) {
            summary.duplicate++;
            continue;
          }

          if (doc.id) {
            const exist = await prisma.repack.findUnique({
              where: { id: doc.id },
            });
            if (exist) {
              await prisma.syncInbound.create({
                data: {
                  clientId: client.id,
                  resource: "repack",
                  clientDocId: doc.clientDocId,
                  serverDocId: exist.id,
                  status: "DUPLICATE",
                },
              });
              summary.duplicate++;
              continue;
            }
          }

          // Validasi UOM
          for (const i of doc.inputs) await ensureUomExists(i.productId, i.uom);
          for (const o of doc.outputs)
            await ensureUomExists(o.productId, o.uom);

          const createdAt = doc.createdAt ?? new Date();
          const number = doc.number ?? nextRepackNumber();
          const locationId = await resolveRepackLocation(
            doc.locationCode ?? null
          );

          const created = await prisma.$transaction(async (tx) => {
            const header = await tx.repack.create({
              data: {
                id: doc.id, // optional
                number,
                notes: doc.notes ?? undefined,
                extraCost: doc.extraCost ?? 0,
                createdAt,
              },
              select: { id: true },
            });

            // Input => REPACK_OUT (qty negatif)
            for (const i of doc.inputs) {
              await tx.repackInput.create({
                data: {
                  repackId: header.id,
                  productId: i.productId,
                  uom: i.uom,
                  qty: i.qty,
                },
              });
              await tx.stockMove.create({
                data: {
                  productId: i.productId,
                  locationId,
                  qty: -i.qty,
                  uom: i.uom,
                  type: "REPACK_OUT",
                  refId: header.id,
                  createdAt,
                },
              });
            }

            // Output => REPACK_IN (qty positif)
            // hpp/harga pokok output = 0 (sementara), karena repack.ts Anda juga belum hitung HPP.
            for (const o of doc.outputs) {
              await tx.repackOutput.create({
                data: {
                  repackId: header.id,
                  productId: o.productId,
                  uom: o.uom,
                  qty: o.qty,
                  hpp: 0,
                },
              });
              await tx.stockMove.create({
                data: {
                  productId: o.productId,
                  locationId,
                  qty: o.qty,
                  uom: o.uom,
                  type: "REPACK_IN",
                  refId: header.id,
                  createdAt,
                },
              });
            }

            await tx.syncInbound.create({
              data: {
                clientId: client.id,
                resource: "repack",
                clientDocId: doc.clientDocId,
                serverDocId: header.id,
                status: "SUCCESS",
              },
            });

            return header;
          });

          summary.created++;
          app.log.info({ repackId: created.id }, "sync-pushRepack-success");
        } catch (e) {
          summary.errors++;
          app.log.error({ err: e }, "sync-pushRepack-error");
        }
      }

      return reply.send({ ok: true, clientId: client.id, summary });
    }
  );

  // =================
  // /sync/pushTransfers
  // =================
  app.post(
    "/sync/pushTransfers",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      let client: any;
      try {
        client = await ensureClient(req);
      } catch (e: any) {
        return reply.code(e.code || 400).send({ ok: false, error: e.message });
      }

      const parsed = PushTransfersBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      }
      const body = parsed.data;

      const summary = { created: 0, duplicate: 0, errors: 0 };

      for (const doc of body.transfers) {
        try {
          // idempotensi
          const existInbound = await prisma.syncInbound.findUnique({
            where: {
              clientId_resource_clientDocId: {
                clientId: client.id,
                resource: "transfer",
                clientDocId: doc.clientDocId,
              },
            } as any,
          });
          if (existInbound) {
            summary.duplicate++;
            continue;
          }

          const createdAt = doc.createdAt ?? new Date();

          const [fromLoc, toLoc] = await Promise.all([
            prisma.location.findUnique({
              where: { code: doc.fromLocationCode },
            }),
            prisma.location.findUnique({ where: { code: doc.toLocationCode } }),
          ]);
          if (!fromLoc)
            throw new Error(
              `Lokasi asal tidak ditemukan: ${doc.fromLocationCode}`
            );
          if (!toLoc)
            throw new Error(
              `Lokasi tujuan tidak ditemukan: ${doc.toLocationCode}`
            );
          if (fromLoc.id === toLoc.id) {
            throw new Error("Lokasi asal dan tujuan tidak boleh sama");
          }

          // validasi UOM
          const uomValid = await prisma.productUom.findFirst({
            where: { productId: doc.productId, uom: doc.uom },
          });
          if (!uomValid)
            throw new Error(`UOM ${doc.uom} belum terdaftar pada produk`);

          // Cek stok cukup di fromLoc (dengan konversi)
          const uoms = await prisma.productUom.findMany({
            where: { productId: doc.productId },
            select: { uom: true, toBase: true },
          });
          const tbMap = new Map<string, number>();
          for (const r of uoms) tbMap.set(r.uom, Number(r.toBase));

          const tbOut = tbMap.get(doc.uom);
          if (!tbOut)
            throw new Error(`UOM ${doc.uom} belum terdaftar pada produk`);

          const needBase = doc.qty * tbOut;

          const movesFrom = await prisma.stockMove.findMany({
            where: { productId: doc.productId, locationId: fromLoc.id },
            select: { qty: true, uom: true },
          });
          let haveBase = 0;
          for (const m of movesFrom) {
            const t = tbMap.get(m.uom);
            if (!t) continue;
            haveBase += Number(m.qty) * t;
          }
          if (haveBase + 1e-9 < needBase) {
            throw new Error(
              `Stok tidak cukup di ${doc.fromLocationCode}. Sisa(base)=${haveBase}, butuh(base)=${needBase}`
            );
          }

          // refId grouping: pakai doc.refId jika ada, otherwise gen:
          const groupRefId =
            doc.refId ??
            `TRF-${Date.now().toString(16)}-${Math.random()
              .toString(16)
              .slice(2, 8)}`;

          await prisma.$transaction(async (tx) => {
            await tx.stockMove.create({
              data: {
                productId: doc.productId,
                locationId: fromLoc.id,
                qty: -doc.qty,
                uom: doc.uom,
                type: "TRANSFER",
                refId: groupRefId,
                createdAt,
              },
            });
            await tx.stockMove.create({
              data: {
                productId: doc.productId,
                locationId: toLoc.id,
                qty: doc.qty,
                uom: doc.uom,
                type: "TRANSFER",
                refId: groupRefId,
                createdAt,
              },
            });

            await tx.syncInbound.create({
              data: {
                clientId: client.id,
                resource: "transfer",
                clientDocId: doc.clientDocId,
                serverDocId: groupRefId,
                status: "SUCCESS",
              },
            });
          });

          summary.created++;
          app.log.info({ refId: groupRefId }, "sync-pushTransfers-success");
        } catch (e) {
          summary.errors++;
          app.log.error({ err: e }, "sync-pushTransfers-error");
        }
      }

      return reply.send({ ok: true, clientId: client.id, summary });
    }
  );

  // ===============
  // /sync/pushAdjustments
  // ===============
  app.post(
    "/sync/pushAdjustments",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      let client: any;
      try {
        client = await ensureClient(req);
      } catch (e: any) {
        return reply.code(e.code || 400).send({ ok: false, error: e.message });
      }

      const parsed = PushAdjustmentsBody.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      const body = parsed.data;

      const summary = { created: 0, duplicate: 0, errors: 0 };

      for (const adj of body.adjustments) {
        try {
          const inbound = await prisma.syncInbound.findUnique({
            where: {
              clientId_resource_clientDocId: {
                clientId: client.id,
                resource: "adjustment",
                clientDocId: adj.clientDocId,
              },
            } as any,
          });
          if (inbound) {
            summary.duplicate++;
            continue;
          }

          const loc = await prisma.location.findUnique({
            where: { code: adj.locationCode },
          });
          if (!loc)
            throw new Error(`Lokasi tidak ditemukan: ${adj.locationCode}`);
          await ensureUomExists(adj.productId, adj.uom);

          const createdAt = adj.createdAt ?? new Date();
          const move = await prisma.stockMove.create({
            data: {
              productId: adj.productId,
              locationId: loc.id,
              qty: new Prisma.Decimal(adj.qty),
              uom: adj.uom,
              type: "ADJUSTMENT",
              refId: adj.refId ?? null,
              createdAt,
            },
            select: { id: true },
          });

          await prisma.syncInbound.create({
            data: {
              clientId: client.id,
              resource: "adjustment",
              clientDocId: adj.clientDocId,
              serverDocId: move.id,
              status: "SUCCESS",
            },
          });
          summary.created++;
        } catch (e) {
          summary.errors++;
          app.log.error({ err: e }, "sync-pushAdjustments-error");
        }
      }

      return reply.send({ ok: true, clientId: client.id, summary });
    }
  );
}
