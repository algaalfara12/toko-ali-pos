import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildAdjustmentsReportPdf } from "../utils/pdf";

// ===== Helper tanggal =====
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

// ===== Store branding =====
async function loadStoreBrand() {
  const sp = await prisma.storeProfile.findFirst();
  const brand = {
    storeName: sp?.name ?? "TOKO ALI POS",
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

export default async function reportsAdjustRoutes(app: FastifyInstance) {
  app.get(
    "/reports/stock/adjustments",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const q = req.query as any;
      const df0 = parseISODate(q.date_from);
      const dt0 = parseISODate(q.date_to);
      const dateFrom = df0 ? dayStart(df0) : undefined;
      const dateTo = dt0 ? dayEnd(dt0) : undefined;
      const productId = q.productId ? String(q.productId) : undefined;
      const locationCode = q.locationCode ? String(q.locationCode) : undefined;
      const exportFmt = String(q.export || "").toLowerCase();

      const where: any = { type: "ADJUSTMENT" };
      if (dateFrom && dateTo) where.createdAt = { gte: dateFrom, lte: dateTo };
      if (productId) where.productId = productId;
      if (locationCode) where.location = { code: locationCode };

      const moves = await prisma.stockMove.findMany({
        where,
        orderBy: { createdAt: "asc" },
        include: {
          product: { select: { sku: true, name: true } },
          location: { select: { code: true, name: true } },
        },
      });

      const data = moves.map((m) => ({
        date: m.createdAt.toISOString().slice(0, 10),
        refId: m.refId ?? "",
        sku: m.product?.sku ?? "",
        name: m.product?.name ?? "",
        location: `${m.location.code} - ${m.location.name ?? ""}`,
        uom: m.uom,
        qty: Number(m.qty),
      }));

      if (exportFmt === "csv") {
        const headers = [
          "date",
          "refId",
          "sku",
          "name",
          "location",
          "uom",
          "qty",
        ];
        const csv = toCsv(headers, data);
        return sendCsv(
          reply,
          `adjustments_${q.date_from || "ALL"}_${q.date_to || "ALL"}.csv`,
          csv
        );
      }

      if (exportFmt === "pdf") {
        const brand = await loadStoreBrand();
        const periodLabel =
          q.date_from && q.date_to
            ? `${q.date_from} s/d ${q.date_to}`
            : "Semua Waktu";

        const buf = await buildAdjustmentsReportPdf({
          storeName: brand.storeName,
          periodLabel,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows: data,
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="adjustments_${q.date_from || "ALL"}_${
            q.date_to || "ALL"
          }.pdf"`
        );
        return reply.send(buf);
      }

      return reply.send({
        ok: true,
        filter: {
          date_from: dateFrom,
          date_to: dateTo,
          productId,
          locationCode,
        },
        count: data.length,
        data,
      });
    }
  );
}
