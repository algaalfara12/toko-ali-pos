import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";

// Input body:
// - productIds?: string[]           → optional filter
// - locationCodes?: string[]        → optional filter
// - perUom?: boolean                → kalau true, kembalikan breakdown per UOM
// - limit?: number                  → optional, batasi jumlah (opsional)
// - since?: string (ISO) (OPSIONAL) → bukan wajib, untuk versi delta di masa depan
const PullStockBody = z.object({
  productIds: z.array(z.string().uuid()).optional(),
  locationCodes: z.array(z.string().min(1)).optional(),
  perUom: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
  since: z.string().optional(), // rencana ke depan (delta), tidak dipakai dulu
});

export default async function syncStockRoutes(app: FastifyInstance) {
  app.post(
    "/sync/pullStock",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang", "kasir"])] },
    async (req, reply) => {
      const parsed = PullStockBody.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      }
      const { productIds, locationCodes, perUom, limit } = parsed.data;

      // 1) Resolve locations by codes (jika tidak diisi → semua)
      let locRows = await prisma.location.findMany({
        where: locationCodes?.length
          ? { code: { in: locationCodes } }
          : undefined,
        select: { id: true, code: true, name: true },
      });
      if (!locRows.length) {
        return reply.code(400).send({
          ok: false,
          error:
            "Tidak ada lokasi yang cocok (periksa locationCodes atau buat lokasi dulu)",
        });
      }
      const locIdToInfo = new Map<string, { code: string; name: string }>();
      const locIds = locRows.map((l) => {
        locIdToInfo.set(l.id, { code: l.code, name: l.name });
        return l.id;
      });

      // 2) Batasi produk (kalau diisi), jika tidak → semua (hati-hati beban besar)
      //    Untuk versi produksi, saya sarankan Anda WAJIB mengirim productIds agar tidak berat.
      let prodFilter = productIds?.length ? { in: productIds } : undefined;

      // 3) Ambil sum per (productId, locationId, uom) langsung dari DB + max(createdAt)
      //    -> Ini menjamin semua jenis StockMove (IN/SALE/RETURN/REPACK_IN/REPACK_OUT/TRANSFER/ADJUSTMENT/HOLD) terhitung,
      //       karena kita tidak memfilter by "type"; kita akumulasikan semua qty (positif/negatif).
      const rows = await prisma.stockMove.groupBy({
        by: ["productId", "locationId", "uom"],
        where: {
          ...(prodFilter ? { productId: prodFilter } : {}),
          locationId: { in: locIds },
          // (opsional) untuk delta, tambahkan createdAt > since di masa depan
        },
        _sum: { qty: true },
        _max: { createdAt: true },
      });

      // 4) Siapkan toBase map untuk semua productId yang muncul
      const productSet = Array.from(new Set(rows.map((r) => r.productId)));
      const uoms = await prisma.productUom.findMany({
        where: { productId: { in: productSet } },
        select: { productId: true, uom: true, toBase: true },
      });
      const toBase = new Map<string, number>(); // key: `${pid}::${uom}`
      for (const u of uoms)
        toBase.set(`${u.productId}::${u.uom}`, Number(u.toBase) || 0);

      // 5) Gabungkan ke (productId, locationId)
      interface PerUomRow {
        uom: string;
        qty: number;
      }
      interface StockAggregate {
        productId: string;
        locationId: string;
        balanceBase: number; // Σ (qty * toBase[uom])
        lastMoveAt?: Date | null; // max(createdAt)
        perUom?: PerUomRow[];
      }

      const aggregateMap = new Map<string, StockAggregate>(); // key: `${pid}::${locId}`

      for (const r of rows) {
        const key = `${r.productId}::${r.locationId}`;
        let agg = aggregateMap.get(key);
        if (!agg) {
          agg = {
            productId: r.productId,
            locationId: r.locationId,
            balanceBase: 0,
            lastMoveAt: r._max.createdAt ?? null,
            perUom: perUom ? [] : undefined,
          };
          aggregateMap.set(key, agg);
        } else {
          // update lastMoveAt
          const maxAt = r._max?.createdAt ?? null;
          if (!agg.lastMoveAt || (maxAt && maxAt > agg.lastMoveAt)) {
            agg.lastMoveAt = maxAt;
          }
        }

        // convert qty di UOM ini → base & akumulasi
        const sumQty = Number(r._sum.qty ?? 0);
        const tb = toBase.get(`${r.productId}::${r.uom}`) || 0;
        agg.balanceBase += sumQty * tb;

        // perUom breakdown (optional)
        if (perUom && agg.perUom) {
          agg.perUom.push({ uom: r.uom, qty: sumQty });
        }
      }

      // 6) Map LocationId → code, name & kemas final
      let data = Array.from(aggregateMap.values()).map((agg) => {
        const loc = locIdToInfo.get(agg.locationId) || { code: "", name: "" };
        return {
          productId: agg.productId,
          location: { code: loc.code, name: loc.name },
          balanceBase: agg.balanceBase, // total dalam base unit
          lastMoveAt: agg.lastMoveAt,
          ...(perUom ? { perUom: agg.perUom } : {}),
        };
      });

      // 7) Optional: batasi jumlah agar ringan
      if (limit && limit > 0 && data.length > limit) {
        data = data.slice(0, limit);
      }

      return reply.send({
        ok: true,
        count: data.length,
        data,
      });
    }
  );
}
