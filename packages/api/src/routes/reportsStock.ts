import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildStockSummaryPdf, buildStockMovementsPdf } from "../utils/pdf";

// ==== Helper: brand + logo ====
async function loadStoreBrand() {
  const sp = await prisma.storeProfile.findFirst();
  const brand = {
    storeName: sp?.name ?? "TOKO ALI POS",
    storeAddress: sp?.address ?? undefined,
    storePhone: sp?.phone ?? undefined,
    storeFooterNote: sp?.footerNote ?? undefined,
    logoUrl: sp?.logoUrl ?? undefined,
  };
  let storeLogoBuffer: Buffer | undefined;
  if (brand.logoUrl) {
    try {
      const r = await fetch(brand.logoUrl);
      if (r.ok) {
        const arr = await r.arrayBuffer();
        storeLogoBuffer = Buffer.from(arr);
      }
    } catch {}
  }
  return { ...brand, storeLogoBuffer };
}

function dayStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function dayEnd(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function parseISODate(s?: string): Date | undefined {
  if (!s) return;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return;
  return new Date(y, m - 1, d);
}

// ==== UOM helpers (duplikasi ringan dari stock.ts) ====
async function loadUomMap(productId: string) {
  const rows = await prisma.productUom.findMany({
    where: { productId },
    select: { uom: true, toBase: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.uom, Number(r.toBase));
  return map;
}
function toBaseQtyWithMap(
  uomMap: Map<string, number>,
  uom: string,
  qty: number
) {
  const tb = uomMap.get(uom);
  if (!tb) throw new Error(`UOM ${uom} belum terdaftar pada produk`);
  return tb * qty;
}

export default async function reportsStockRoutes(app: FastifyInstance) {
  // ==========================================================
  // 1) STOCK SUMMARY (Pivot Gudang & Etalase)
  //    GET /reports/stock/summary?as_of=YYYY-MM-DD&productId=&pivot=GUDANG,ETALASE&export=pdf|csv
  //    RBAC: admin, petugas_gudang
  // ==========================================================
  app.get(
    "/reports/stock/summary",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const Q = z.object({
        as_of: z.string().optional(), // default: hari ini
        productId: z.string().uuid().optional(),
        pivot: z.string().optional(), // "GUDANG,ETALASE"
        export: z.string().optional(), // pdf/csv
      });

      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      const { as_of, productId, pivot, export: exportFmtRaw } = p.data;
      const exportFmt = (exportFmtRaw ?? "").toLowerCase();

      const asOf = as_of ? parseISODate(as_of)! : new Date();
      const asOfEnd = dayEnd(asOf);

      // Tentukan dua lokasi pivot: default "GUDANG,ETALASE"
      const [colAcode, colBcode] = (pivot ?? "GUDANG,ETALASE")
        .split(",")
        .map((s) => s.trim());
      const locA = await prisma.location.findUnique({
        where: { code: colAcode },
      });
      const locB = await prisma.location.findUnique({
        where: { code: colBcode },
      });
      if (!locA || !locB) {
        return reply.code(400).send({
          ok: false,
          error: `Lokasi pivot tidak ditemukan: ${colAcode}/${colBcode}`,
        });
      }

      // Ambil semua pergerakan s.d as_ofEnd utk product (opsional)
      const where: any = {
        createdAt: { lte: asOfEnd },
        ...(productId ? { productId } : {}),
        // lokasi lain juga kita ambil karena total = gudang+etalase, tapi agar pivot fokus,
        // untuk efisiensi bisa disaring: locationId IN (locA.id, locB.id)
        locationId: { in: [locA.id, locB.id] },
      };

      const moves = await prisma.stockMove.findMany({
        where,
        orderBy: { createdAt: "asc" },
        select: {
          productId: true,
          locationId: true,
          qty: true,
          uom: true,
          product: { select: { sku: true, name: true, baseUom: true } },
        },
      });

      // uomMap per product
      const productIds = Array.from(new Set(moves.map((m) => m.productId)));
      const uomMapPerProduct = new Map<string, Map<string, number>>();
      for (const pid of productIds) {
        uomMapPerProduct.set(pid, await loadUomMap(pid));
      }

      type Row = {
        sku?: string | null;
        name?: string | null;
        baseUom?: string | null;
        qtyGudang: number;
        qtyEtalase: number;
        qtyTotal: number;
      };
      const agg = new Map<string, Row>(); // key = productId

      for (const m of moves) {
        const key = m.productId;
        if (!agg.has(key)) {
          agg.set(key, {
            sku: m.product?.sku ?? null,
            name: m.product?.name ?? null,
            baseUom: m.product?.baseUom ?? null,
            qtyGudang: 0,
            qtyEtalase: 0,
            qtyTotal: 0,
          });
        }
        const row = agg.get(key)!;
        const umap = uomMapPerProduct.get(m.productId)!;
        const baseQty = toBaseQtyWithMap(umap, m.uom, Number(m.qty));
        if (m.locationId === locA.id) row.qtyGudang += baseQty;
        else if (m.locationId === locB.id) row.qtyEtalase += baseQty;
      }

      for (const r of agg.values()) {
        r.qtyTotal = r.qtyGudang + r.qtyEtalase;
      }

      const rows = Array.from(agg.values()).sort((a, b) =>
        (a.sku ?? "").localeCompare(b.sku ?? "")
      );

      // === CSV ===
      if (exportFmt === "csv") {
        const headers = [
          "as_of",
          "sku",
          "name",
          "baseUom",
          colAcode.toLowerCase(),
          colBcode.toLowerCase(),
          "total",
        ];
        const rowsCsv = rows.map((r) => ({
          as_of: as_of ?? new Date().toISOString().slice(0, 10),
          sku: r.sku ?? "",
          name: r.name ?? "",
          baseUom: r.baseUom ?? "",
          [colAcode.toLowerCase()]: String(
            Math.round(r.qtyGudang * 1000) / 1000
          ),
          [colBcode.toLowerCase()]: String(
            Math.round(r.qtyEtalase * 1000) / 1000
          ),
          total: String(Math.round(r.qtyTotal * 1000) / 1000),
        }));
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(
          reply,
          `stock_summary_${as_of || "today"}_${colAcode}-${colBcode}.csv`,
          csv
        );
      }

      // === PDF (landscape pivot + label kolom dinamis) ===
      if (exportFmt === "pdf") {
        const brand = await loadStoreBrand();
        const buf = await buildStockSummaryPdf({
          storeName: brand.storeName,
          periodLabel: `Per ${
            as_of ?? new Date().toISOString().slice(0, 10)
          } (as-of 23:59)`,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          // ⬇️ LABEL KOLOM DINAMIS SESUAI PIVOT
          colAName: colAcode,
          colBName: colBcode,
          // ⬇️ DATA: qtyGudang ↔ locA, qtyEtalase ↔ locB SUDAH TERJAMIN dari aggregator di atas
          rows,
        });
        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="stock_summary_${
            as_of || "today"
          }_${colAcode}-${colBcode}.pdf"`
        );
        return reply.send(buf);
      }
    }
  );

  // ==========================================================
  // 2) STOCK MOVEMENTS
  //    GET /reports/stock/movements?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&locationCode=&productId=&type=&export=pdf|csv
  //    RBAC: admin, petugas_gudang
  // ==========================================================
  app.get(
    "/reports/stock/movements",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        locationCode: z.string().optional(),
        productId: z.string().uuid().optional(),
        type: z
          .enum(["IN", "SALE", "RETURN", "TRANSFER", "ADJUSTMENT", "REPACK"])
          .optional(),
        export: z.string().optional(), // pdf/csv
      });

      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      const {
        date_from,
        date_to,
        locationCode,
        productId,
        type,
        export: exportFmtRaw,
      } = p.data;
      const exportFmt = (exportFmtRaw ?? "").toLowerCase();

      let start: Date | undefined;
      let end: Date | undefined;
      if (date_from) start = dayStart(parseISODate(date_from)!);
      if (date_to) end = dayEnd(parseISODate(date_to)!);

      let createdAtFilter: any = undefined;
      if (start && end) createdAtFilter = { gte: start, lte: end };
      else if (start) createdAtFilter = { gte: start };
      else if (end) createdAtFilter = { lte: end };
      // jika tidak ada start & end → all-time (tanpa filter tanggal)

      let locationIdFilter: string | undefined;
      if (locationCode) {
        const loc = await prisma.location.findUnique({
          where: { code: locationCode },
        });
        if (!loc)
          return reply.code(404).send({
            ok: false,
            error: `Lokasi tidak ditemukan: ${locationCode}`,
          });
        locationIdFilter = loc.id;
      }

      const where: any = {
        ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
        ...(locationIdFilter ? { locationId: locationIdFilter } : {}),
        ...(productId ? { productId } : {}),
        ...(type ? { type } : {}),
      };

      const moves = await prisma.stockMove.findMany({
        where,
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          type: true,
          refId: true,
          uom: true,
          qty: true,
          product: { select: { sku: true, name: true } },
          location: { select: { code: true, name: true } },
        },
      });

      if (exportFmt === "csv") {
        const headers = [
          "date",
          "type",
          "refId",
          "sku",
          "name",
          "location",
          "uom",
          "qty",
        ];
        const rowsCsv = moves.map((m) => ({
          date: m.createdAt.toISOString(),
          type: m.type,
          refId: m.refId ?? "",
          sku: m.product?.sku ?? "",
          name: m.product?.name ?? "",
          location: `${m.location?.code ?? ""}${
            m.location?.name ? ` - ${m.location.name}` : ""
          }`,
          uom: m.uom,
          qty: String(Number(m.qty)),
        }));
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(
          reply,
          `stock_movements_${date_from || "ALL"}_${date_to || "ALL"}_${
            type || "ALL"
          }.csv`,
          csv
        );
      }

      if (exportFmt === "pdf") {
        const brand = await loadStoreBrand();
        const buf = await buildStockMovementsPdf({
          storeName: brand.storeName,
          periodLabel: `${date_from ?? "ALL"} s/d ${date_to ?? "ALL"}${
            type ? ` | ${type}` : ""
          }`,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows: moves.map((m) => ({
            createdAt: m.createdAt,
            type: m.type,
            refId: m.refId ?? null,
            sku: m.product?.sku ?? "",
            name: m.product?.name ?? "",
            locationCode: m.location?.code ?? "",
            locationName: m.location?.name ?? "",
            uom: m.uom,
            qty: Number(m.qty),
          })),
        });
        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="stock_movements_${date_from || "ALL"}_${
            date_to || "ALL"
          }_${type || "ALL"}.pdf"`
        );
        return reply.send(buf);
      }

      return reply.send({
        ok: true,
        from: date_from ?? null,
        to: date_to ?? null,
        locationCode: locationCode ?? null,
        productId: productId ?? null,
        type: type ?? null,
        count: moves.length,
        data: moves,
      });
    }
  );
}
