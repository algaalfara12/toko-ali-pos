// packages/api/src/routes/sync.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { Prisma } from "@prisma/client";
import { loadEnv } from "../config/env";

const env = loadEnv();
// --- bantu parse tanggal ---
const ZDateOpt = z.preprocess((v) => {
  if (!v) return undefined;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}, z.date().optional());

// --- Skema payload per resource ---
// NOTE: id optional agar client boleh kirim UUID (atau tanpa id → pakai fallback uniq key)
const ProductPush = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1),
  name: z.string().min(1),
  baseUom: z.string().min(1),
  isActive: z.boolean().optional(),
  updatedAt: ZDateOpt,
});

const ProductUomPush = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid(),
  uom: z.string().min(1),
  toBase: z.number().int().min(1),
  updatedAt: ZDateOpt,
});

const BarcodePush = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid(),
  uom: z.string().min(1),
  code: z.string().min(1),
  updatedAt: ZDateOpt,
});

const PriceListPush = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid(),
  uom: z.string().min(1),
  price: z.number(), // akan dikonversi Decimal
  active: z.boolean().optional(),
  updatedAt: ZDateOpt,
});

const CustomerPush = z.object({
  id: z.string().uuid().optional(),
  name: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  memberCode: z.string().nullable().optional(),
  joinedAt: ZDateOpt,
  isActive: z.boolean().optional(),
  updatedAt: ZDateOpt,
});

const LocationPush = z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(1), // unik
  name: z.string().min(1),
  updatedAt: ZDateOpt,
});

// --- Tombstone (global delete) ---
const TombstoneDelete = z.object({
  resource: z.enum([
    "products",
    "productUoms",
    "prices",
    "barcodes",
    "customers",
    "locations",
    "storeProfile",
  ]),
  id: z.string().min(1),
  deletedAt: ZDateOpt,
});

// --- Body schema untuk push ---
const PushBody = z.object({
  products: z.array(ProductPush).optional(),
  productUoms: z.array(ProductUomPush).optional(),
  barcodes: z.array(BarcodePush).optional(),
  prices: z.array(PriceListPush).optional(),
  customers: z.array(CustomerPush).optional(),
  locations: z.array(LocationPush).optional(),
  deletes: z.array(TombstoneDelete).optional(),
});

export default async function syncRoutes(app: FastifyInstance) {
  app.get(
    "/sync/pull",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (req, reply) => {
      // 1) Header device
      const deviceId =
        (req.headers["x-device-id"] as string)?.trim() || "UNKNOWN-DEVICE";
      if (!deviceId || deviceId === "UNKNOWN-DEVICE") {
        return reply.code(400).send({
          ok: false,
          error: {
            code: "NO_DEVICE_ID",
            message: "X-Device-Id header wajib",
          },
          reqId: req.id,
        });
      }

      // 2) Query parameters
      const Q = z.object({
        resources: z.string().optional(), // comma-separated
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        since: z.string().datetime().optional(),
      });
      const pq = Q.safeParse(req.query);
      if (!pq.success) {
        return reply
          .code(400)
          .send({ ok: false, error: pq.error.flatten(), reqId: req.id });
      }
      const limit = pq.data.limit;
      const resources = (
        pq.data.resources ||
        "products,productUoms,prices,barcodes,customers,locations,storeProfile"
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const sinceDt = pq.data.since ? new Date(pq.data.since) : null;
      if (sinceDt && Number.isNaN(sinceDt.getTime())) {
        return reply.code(400).send({
          ok: false,
          error: { code: "BAD_SINCE", message: "since harus ISO date valid" },
          reqId: req.id,
        });
      }

      // 3) Pastikan SyncClient ada (tanpa lastSeenAt — sesuai schema kamu)
      const ua =
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : undefined;
      const client = await prisma.syncClient.upsert({
        where: { deviceId },
        create: {
          deviceId,
          name: deviceId,
          userAgent: ua,
        },
        update: {
          userAgent: ua,
        },
      });

      // 4) Ambil or buat checkpoint per resource
      //    - checkpoint.since diisi timestamp terakhir data diambil (UTC)
      //    - nextSince = now() → untuk di-save sebagai checkpoint baru
      const now = new Date();

      const result: Record<string, any[]> = {};
      const checkpointsToUpsert: { resource: string; since: Date }[] = [];

      // === helper: ambil since dari checkpoint ===
      async function getSince(resource: string): Promise<Date | null> {
        const cp = await prisma.syncCheckpoint.findUnique({
          where: { clientId_resource: { clientId: client.id, resource } },
          select: { since: true },
        });
        return cp?.since ?? null;
      }

      // === PRODUCTS (punya updatedAt di schema kamu) ===
      if (resources.includes("products")) {
        const since = await getSince("products");
        const where = since ? { updatedAt: { gt: since } } : {};
        const data = await prisma.product.findMany({
          where,
          orderBy: { updatedAt: "asc" },
          take: limit,
          select: {
            id: true,
            sku: true,
            name: true,
            baseUom: true,
            isActive: true,
            updatedAt: true,
          },
        });
        result["products"] = data;
        checkpointsToUpsert.push({ resource: "products", since: now });
      }

      // === PRODUCT UOMS (kalau sudah ada updatedAt; jika tidak, kirim full) ===
      if (resources.includes("productUoms")) {
        let data: any[] = [];
        try {
          const since = await getSince("productUoms");
          const where = since ? ({ updatedAt: { gt: since } } as any) : {};
          data = await prisma.productUom.findMany({
            where,
            orderBy: { updatedAt: "asc" } as any,
            take: limit,
            select: {
              id: true,
              productId: true,
              uom: true,
              toBase: true,
              // @ts-ignore (abaikan bila belum ada di schema)
              updatedAt: true,
            } as any,
          });
        } catch {
          // fallback: kalau kolom updatedAt tidak ada → kirim full terbatas
          data = await prisma.productUom.findMany({
            take: limit,
            select: { id: true, productId: true, uom: true, toBase: true },
          });
        }
        result["productUoms"] = data;
        checkpointsToUpsert.push({ resource: "productUoms", since: now });
      }

      // === PRICES (PriceList) ===
      if (resources.includes("prices")) {
        let data: any[] = [];
        try {
          const since = await getSince("prices");
          const where = since ? ({ updatedAt: { gt: since } } as any) : {};
          data = await prisma.priceList.findMany({
            where,
            orderBy: { updatedAt: "asc" } as any,
            take: limit,
            select: {
              id: true,
              productId: true,
              uom: true,
              price: true,
              active: true,
              // @ts-ignore
              updatedAt: true,
            } as any,
          });
        } catch {
          data = await prisma.priceList.findMany({
            take: limit,
            select: {
              id: true,
              productId: true,
              uom: true,
              price: true,
              active: true,
            },
          });
        }
        result["prices"] = data;
        checkpointsToUpsert.push({ resource: "prices", since: now });
      }

      // === BARCODES (umumnya tidak ada updatedAt) ===
      if (resources.includes("barcodes")) {
        const data = await prisma.barcode.findMany({
          take: limit,
          select: { id: true, productId: true, uom: true, code: true },
        });
        result["barcodes"] = data;
        // tetap simpan since untuk tracking
        checkpointsToUpsert.push({ resource: "barcodes", since: now });
      }

      // === CUSTOMERS ===
      if (resources.includes("customers")) {
        let data: any[] = [];
        try {
          const since = await getSince("customers");
          const where = since ? ({ updatedAt: { gt: since } } as any) : {};
          data = await prisma.customer.findMany({
            where,
            orderBy: { updatedAt: "asc" } as any,
            take: limit,
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              memberCode: true,
              isActive: true,
              // @ts-ignore
              updatedAt: true,
            } as any,
          });
        } catch {
          data = await prisma.customer.findMany({
            take: limit,
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              memberCode: true,
              isActive: true,
            },
          });
        }
        result["customers"] = data;
        checkpointsToUpsert.push({ resource: "customers", since: now });
      }

      // === LOCATIONS ===
      if (resources.includes("locations")) {
        let data: any[] = [];
        try {
          const since = await getSince("locations");
          const where = since ? ({ updatedAt: { gt: since } } as any) : {};
          data = await prisma.location.findMany({
            where,
            orderBy: { updatedAt: "asc" } as any,
            take: limit,
            select: {
              id: true,
              code: true,
              name: true,
              // @ts-ignore
              updatedAt: true,
            } as any,
          });
        } catch {
          data = await prisma.location.findMany({
            take: limit,
            select: { id: true, code: true, name: true },
          });
        }
        result["locations"] = data;
        checkpointsToUpsert.push({ resource: "locations", since: now });
      }

      // === STORE PROFILE (single) ===
      if (resources.includes("storeProfile")) {
        const sp = await prisma.storeProfile.findFirst({
          select: {
            id: true,
            name: true,
            address: true,
            phone: true,
            logoUrl: true,
            footerNote: true,
            timezone: true,
            updatedAt: true,
          },
        });
        result["storeProfile"] = sp ? [sp] : [];
        checkpointsToUpsert.push({ resource: "storeProfile", since: now });
      }

      // 5) Upsert checkpoints untuk semua resource yang diminta
      for (const cp of checkpointsToUpsert) {
        await prisma.syncCheckpoint.upsert({
          where: {
            clientId_resource: { clientId: client.id, resource: cp.resource },
          },
          create: {
            clientId: client.id,
            resource: cp.resource,
            since: cp.since,
          },
          update: { since: cp.since },
        });
      }

      let tombstones: Array<{
        entityId: string; // ⬅️ entityId yang dihapus
        resource: string;
        deletedAt: string;
      }> = [];
      if (sinceDt) {
        tombstones = await prisma.tombstone
          .findMany({
            where: {
              deletedAt: { gt: sinceDt },
              resource: { in: resources },
            },
            orderBy: { deletedAt: "asc" },
            take: limit,
            // ⬅️ PENTING: ambil entityId, bukan id
            select: { entityId: true, resource: true, deletedAt: true },
          })
          .then((rows) =>
            rows.map((r) => ({
              entityId: r.entityId,
              resource: r.resource,
              deletedAt: r.deletedAt.toISOString(),
            }))
          );
      }

      return reply.send({
        ok: true,
        clientId: client.id,
        data: result,
        tombstones, // ⬅️ TAMBAH: array tombstones
        nextCheckpoint: now.toISOString(),
      });
    }
  );

  app.post(
    "/sync/push",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (req, reply) => {
      const deviceId = String(req.headers["x-device-id"] || "").trim();
      if (!deviceId) {
        return reply
          .code(400)
          .send({ ok: false, error: "Missing x-device-id" });
      }

      // Upsert SyncClient (tanpa lastSeenAt — updatedAt akan terisi otomatis)
      const userAgent = req.headers["user-agent"] ?? null;
      const client = await prisma.syncClient.upsert({
        where: { deviceId },
        create: {
          deviceId,
          name: deviceId,
          userAgent: typeof userAgent === "string" ? userAgent : null,
        },
        update: {
          userAgent: typeof userAgent === "string" ? userAgent : null,
        },
      });

      // Parse body
      const pb = PushBody.safeParse(req.body);
      if (!pb.success) {
        return reply.code(400).send({ ok: false, error: pb.error.flatten() });
      }
      const body = pb.data;

      // ===== Handle deletes terlebih dahulu =====
      if (body.deletes?.length) {
        for (const d of body.deletes) {
          try {
            await addTombstone(d.resource, d.id, d.deletedAt ?? new Date());
            app.log.info(
              { resource: d.resource, id: d.id },
              "tombstone-created"
            );
          } catch (e) {
            app.log.error(
              { err: e, resource: d.resource, id: d.id },
              "tombstone-error"
            );
          }
        }
      }

      // Utility: compare updatedAt (last-write-wins)
      function isIncomingNewer(incoming?: Date | null, existing?: Date | null) {
        if (!incoming) return false;
        if (!existing) return true;
        return incoming.getTime() > existing.getTime();
      }

      // Result aggregator per resource
      const result = {
        products: { created: 0, updated: 0, skipped: 0, errors: 0 },
        productUoms: { created: 0, updated: 0, skipped: 0, errors: 0 },
        barcodes: { created: 0, updated: 0, skipped: 0, errors: 0 },
        prices: { created: 0, updated: 0, skipped: 0, errors: 0 },
        customers: { created: 0, updated: 0, skipped: 0, errors: 0 },
        locations: { created: 0, updated: 0, skipped: 0, errors: 0 },
      };

      // ===== Tombstone helpers =====
      async function isTombstoned(resource: string, entityId: string) {
        const found = await prisma.tombstone.findUnique({
          where: { resource_entityId: { resource, entityId } as any },
        } as any);
        return !!found;
      }

      async function addTombstone(
        resource: string,
        entityId: string,
        _deletedAt?: Date // ← param tetap tapi diabaikan
      ) {
        // CLOCK SKEW OPTION A — pakai waktu server
        const effectiveDeletedAt = new Date();

        await prisma.tombstone.upsert({
          where: { resource_entityId: { resource, entityId } as any },
          create: { resource, entityId, deletedAt: effectiveDeletedAt },
          update: { deletedAt: effectiveDeletedAt },
        });
      }

      // ===== Upsert helper functions per resource =====

      // Products
      async function upsertProduct(it: z.infer<typeof ProductPush>) {
        try {
          // 1) Delete always wins
          if (it.id && (await isTombstoned("products", it.id))) {
            result.products.skipped++;
            return;
          }

          // 2) Cari existing (by id / sku)
          let existing = null;
          if (it.id) {
            existing = await prisma.product.findUnique({
              where: { id: it.id },
            });
          }
          if (!existing) {
            existing = await prisma.product.findUnique({
              where: { sku: it.sku },
            });
          }

          // 3) Jika existing tapi baris itu sendiri sudah di-tombstone → skip
          if (existing && (await isTombstoned("products", existing.id))) {
            result.products.skipped++;
            return;
          }

          if (!existing) {
            await prisma.product.create({
              data: {
                id: it.id, // boleh null: prisma generate
                sku: it.sku,
                name: it.name,
                baseUom: it.baseUom,
                isActive: it.isActive ?? true,
              },
            });
            result.products.created++;
          } else {
            // compare updatedAt → last-write-wins
            if (!isIncomingNewer(it.updatedAt ?? null, existing.updatedAt)) {
              result.products.skipped++;
              return;
            }
            await prisma.product.update({
              where: { id: existing.id },
              data: {
                sku: it.sku,
                name: it.name,
                baseUom: it.baseUom,
                isActive: it.isActive ?? existing.isActive,
              },
            });
            result.products.updated++;
          }
        } catch (e: any) {
          result.products.errors++;
          app.log.error(
            { err: e, resource: "product", sku: it.sku },
            "sync-push-error"
          );
        }
      }

      // ProductUoms
      async function upsertProductUom(it: z.infer<typeof ProductUomPush>) {
        try {
          // 1) Kalau ID barisnya sendiri di-tombstone → skip
          if (it.id && (await isTombstoned("productUoms", it.id))) {
            result.productUoms.skipped++;
            return;
          }

          // 2) Kalau product yang dirujuk sudah dihapus → skip
          if (await isTombstoned("products", it.productId)) {
            result.productUoms.skipped++;
            return;
          }

          // 3) Cari existing by id / (productId,uom)
          let existing = null;
          if (it.id) {
            existing = await prisma.productUom.findUnique({
              where: { id: it.id },
            });
          }
          if (!existing) {
            existing = await prisma.productUom.findFirst({
              where: { productId: it.productId, uom: it.uom },
            });
          }

          // 4) Jika existing ternyata sudah ditombstone (baris uom ini) → skip
          if (existing && (await isTombstoned("productUoms", existing.id))) {
            result.productUoms.skipped++;
            return;
          }

          if (!existing) {
            await prisma.productUom.create({
              data: {
                id: it.id,
                productId: it.productId,
                uom: it.uom,
                toBase: it.toBase,
              },
            });
            result.productUoms.created++;
          } else {
            if (
              !isIncomingNewer(
                it.updatedAt ?? null,
                (existing as any).updatedAt ?? null
              )
            ) {
              result.productUoms.skipped++;
              return;
            }
            await prisma.productUom.update({
              where: { id: existing.id },
              data: {
                toBase: it.toBase,
              },
            });
            result.productUoms.updated++;
          }
        } catch (e: any) {
          result.productUoms.errors++;
          app.log.error(
            { err: e, resource: "productUom", uom: it.uom },
            "sync-push-error"
          );
        }
      }

      // Barcodes
      async function upsertBarcode(it: z.infer<typeof BarcodePush>) {
        try {
          // 1) Kalau ID barcode ini sendiri sudah di-tombstone → skip
          if (it.id && (await isTombstoned("barcodes", it.id))) {
            result.barcodes.skipped++;
            return;
          }

          // 2) Jika product yang dirujuk sudah dihapus → skip
          if (await isTombstoned("products", it.productId)) {
            result.barcodes.skipped++;
            return;
          }

          // 3) Cari existing by id / code
          let existing = null;
          if (it.id) {
            existing = await prisma.barcode.findUnique({
              where: { id: it.id },
            });
          }
          if (!existing) {
            existing = await prisma.barcode.findUnique({
              where: { code: it.code },
            });
          }

          // 4) Jika existing barcodenya sendiri sudah dihapus (tombstone) → skip
          if (existing && (await isTombstoned("barcodes", existing.id))) {
            result.barcodes.skipped++;
            return;
          }

          if (!existing) {
            await prisma.barcode.create({
              data: {
                id: it.id,
                productId: it.productId,
                uom: it.uom,
                code: it.code,
              },
            });
            result.barcodes.created++;
          } else {
            if (
              !isIncomingNewer(
                it.updatedAt ?? null,
                (existing as any).updatedAt ?? null
              )
            ) {
              result.barcodes.skipped++;
              return;
            }
            await prisma.barcode.update({
              where: { id: existing.id },
              data: {
                productId: it.productId,
                uom: it.uom,
                code: it.code,
              },
            });
            result.barcodes.updated++;
          }
        } catch (e: any) {
          result.barcodes.errors++;
          app.log.error(
            { err: e, resource: "barcode", code: it.code },
            "sync-push-error"
          );
        }
      }

      // PriceList
      async function upsertPrice(it: z.infer<typeof PriceListPush>) {
        try {
          // 1) Jika ID baris price ini sudah di-tombstone → skip
          if (it.id && (await isTombstoned("prices", it.id))) {
            result.prices.skipped++;
            return;
          }

          // 2) Jika product rujukan sudah dihapus → skip
          if (await isTombstoned("products", it.productId)) {
            result.prices.skipped++;
            return;
          }

          // 3) Cari existing (by id, atau (productId,uom,active) true yang terbaru)
          let existing = null;
          if (it.id) {
            existing = await prisma.priceList.findUnique({
              where: { id: it.id },
            });
          }
          if (!existing) {
            existing = await prisma.priceList.findFirst({
              where: { productId: it.productId, uom: it.uom, active: true },
              orderBy: { updatedAt: "desc" as any },
            });
          }

          // 4) Jika existing baris price ini sendiri sudah dihapus → skip
          if (existing && (await isTombstoned("prices", existing.id))) {
            result.prices.skipped++;
            return;
          }

          const priceDecimal = new Prisma.Decimal(it.price);

          if (!existing) {
            await prisma.priceList.create({
              data: {
                id: it.id,
                productId: it.productId,
                uom: it.uom,
                price: priceDecimal,
                active: it.active ?? true,
              },
            });
            result.prices.created++;
          } else {
            if (
              !isIncomingNewer(
                it.updatedAt ?? null,
                (existing as any).updatedAt ?? null
              )
            ) {
              result.prices.skipped++;
              return;
            }
            await prisma.priceList.update({
              where: { id: existing.id },
              data: {
                price: priceDecimal,
                active: it.active ?? existing.active,
              },
            });
            result.prices.updated++;
          }
        } catch (e: any) {
          result.prices.errors++;
          app.log.error(
            { err: e, resource: "priceList", pid: it.productId, uom: it.uom },
            "sync-push-error"
          );
        }
      }

      // Customers
      async function upsertCustomer(it: z.infer<typeof CustomerPush>) {
        try {
          // 1) Kalau ID customer ini sudah di-tombstone → skip
          if (it.id && (await isTombstoned("customers", it.id))) {
            result.customers.skipped++;
            return;
          }

          // 2) Cari existing by id / (phone,email,memberCode)
          let existing = null;
          if (it.id) {
            existing = await prisma.customer.findUnique({
              where: { id: it.id },
            });
          }
          if (!existing) {
            const byPhone = it.phone
              ? await prisma.customer.findUnique({
                  where: { phone: it.phone! },
                })
              : null;
            const byEmail =
              !byPhone && it.email
                ? await prisma.customer.findUnique({
                    where: { email: it.email! },
                  })
                : null;
            const byCode =
              !byPhone && !byEmail && it.memberCode
                ? await prisma.customer.findUnique({
                    where: { memberCode: it.memberCode! },
                  })
                : null;
            existing = byPhone || byEmail || byCode || null;
          }

          // 3) Jika existing customer tsb sudah di-tombstone → skip
          if (existing && (await isTombstoned("customers", existing.id))) {
            result.customers.skipped++;
            return;
          }

          if (!existing) {
            await prisma.customer.create({
              data: {
                id: it.id,
                name: it.name ?? null,
                phone: it.phone ?? null,
                email: it.email ?? null,
                memberCode: it.memberCode ?? null,
                joinedAt: it.joinedAt ?? undefined,
                isActive: it.isActive ?? true,
              },
            });
            result.customers.created++;
          } else {
            if (
              !isIncomingNewer(
                it.updatedAt ?? null,
                (existing as any).updatedAt ?? null
              )
            ) {
              result.customers.skipped++;
              return;
            }
            await prisma.customer.update({
              where: { id: existing.id },
              data: {
                name: it.name ?? existing.name,
                phone: it.phone ?? existing.phone,
                email: it.email ?? existing.email,
                memberCode: it.memberCode ?? existing.memberCode,
                isActive: it.isActive ?? existing.isActive,
              },
            });
            result.customers.updated++;
          }
        } catch (e: any) {
          result.customers.errors++;
          app.log.error(
            { err: e, resource: "customer", phone: it.phone, email: it.email },
            "sync-push-error"
          );
        }
      }

      // Locations
      async function upsertLocation(it: z.infer<typeof LocationPush>) {
        try {
          // 1) Kalau ID lokasi ini di-tombstone → skip
          if (it.id && (await isTombstoned("locations", it.id))) {
            result.locations.skipped++;
            return;
          }

          // 2) Cari existing by id / code
          let existing = null;
          if (it.id) {
            existing = await prisma.location.findUnique({
              where: { id: it.id },
            });
          }
          if (!existing) {
            existing = await prisma.location.findUnique({
              where: { code: it.code },
            });
          }

          // 3) Jika existing lokasi ini sendiri sudah dihapus → skip
          if (existing && (await isTombstoned("locations", existing.id))) {
            result.locations.skipped++;
            return;
          }

          if (!existing) {
            await prisma.location.create({
              data: {
                id: it.id,
                code: it.code,
                name: it.name,
              },
            });
            result.locations.created++;
          } else {
            if (
              !isIncomingNewer(
                it.updatedAt ?? null,
                (existing as any).updatedAt ?? null
              )
            ) {
              result.locations.skipped++;
              return;
            }
            await prisma.location.update({
              where: { id: existing.id },
              data: {
                code: it.code,
                name: it.name,
              },
            });
            result.locations.updated++;
          }
        } catch (e: any) {
          result.locations.errors++;
          app.log.error(
            { err: e, resource: "location", code: it.code },
            "sync-push-error"
          );
        }
      }

      // ===== Jalankan sesuai body =====
      const jobs: Promise<void>[] = [];

      if (body.products)
        for (const it of body.products) jobs.push(upsertProduct(it));
      if (body.productUoms)
        for (const it of body.productUoms) jobs.push(upsertProductUom(it));
      if (body.barcodes)
        for (const it of body.barcodes) jobs.push(upsertBarcode(it));
      if (body.prices) for (const it of body.prices) jobs.push(upsertPrice(it));
      if (body.customers)
        for (const it of body.customers) jobs.push(upsertCustomer(it));
      if (body.locations)
        for (const it of body.locations) jobs.push(upsertLocation(it));

      await Promise.all(jobs);

      // (opsional) kita bisa update/menambahkan checkpoint "push" (bukan keperluan wajib)
      // untuk sekarang cukup kembalikan ringkasan
      return reply.send({
        ok: true,
        clientId: client.id,
        summary: result,
      });
    }
  );
}
