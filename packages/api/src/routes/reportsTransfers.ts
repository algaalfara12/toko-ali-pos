import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildTransfersReportPdf } from "../utils/pdf"; // PDF builder

// helper: parse tanggal (YYYY-MM-DD) → Date lokal (tanpa offset)
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

// ==== Helper: muat StoreProfile + logo (opsional) ====
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
    } catch {
      // abaikan error logo
    }
  }
  return { ...brand, storeLogoBuffer };
}

export default async function reportsTransfersRoutes(app: FastifyInstance) {
  // GET /reports/stock/transfers?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&productId=&locationCode=&export=csv|pdf
  app.get(
    "/reports/stock/transfers",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const q = req.query as any;

      // === Rentang tanggal: jika tidak diberikan → all time (tanpa filter createdAt)
      const df0 = parseISODate(q.date_from);
      const dt0 = parseISODate(q.date_to);
      const dateFrom = df0 ? dayStart(df0) : undefined;
      const dateTo = dt0 ? dayEnd(dt0) : undefined;

      const productId = q.productId ? String(q.productId) : undefined;
      const locationCode = q.locationCode ? String(q.locationCode) : undefined;

      // === Base where untuk semua pencarian
      const baseWhere: any = { type: "TRANSFER" };
      if (dateFrom && dateTo)
        baseWhere.createdAt = { gte: dateFrom, lte: dateTo };
      if (productId) baseWhere.productId = productId;

      // === Ambil moves:
      // Tanpa filter lokasi → ambil semua (baseWhere).
      // Dengan filter lokasi → ambil moves di lokasi tsb (primary), lalu ambil "companion" (refId sama) agar bisa isi 'from' dan 'to'.
      let allMoves: Array<{
        id: string;
        productId: string;
        locationId: string;
        qty: any;
        uom: string;
        refId: string | null;
        createdAt: Date;
        product: { sku: string | null; name: string | null };
        location: { code: string; name: string | null };
      }> = [];

      if (!locationCode) {
        // Tanpa filter lokasi → ambil semua rows
        allMoves = await prisma.stockMove.findMany({
          where: baseWhere,
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            productId: true,
            locationId: true,
            qty: true,
            uom: true,
            refId: true,
            createdAt: true,
            product: { select: { sku: true, name: true } },
            location: { select: { code: true, name: true } },
          },
        });
      } else {
        // Filter lokasi → ambil primary di location tsb
        const primaryMoves = await prisma.stockMove.findMany({
          where: {
            ...baseWhere,
            location: { code: locationCode },
          },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            productId: true,
            locationId: true,
            qty: true,
            uom: true,
            refId: true,
            createdAt: true,
            product: { select: { sku: true, name: true } },
            location: { select: { code: true, name: true } },
          },
        });

        if (!primaryMoves.length) {
          // Tidak ada satupun → tetap kembalikan kosong/CSV kosong/PDF kosong
          // (biarkan alur bawah yang menangani)
          allMoves = primaryMoves;
        } else {
          // Ambil refId non-null untuk companion pairing
          const refIds = Array.from(
            new Set(
              primaryMoves.map((m) => m.refId).filter((r): r is string => !!r)
            )
          );

          let companions: typeof primaryMoves = [];
          if (refIds.length) {
            companions = await prisma.stockMove.findMany({
              where: {
                ...baseWhere,
                refId: { in: refIds },
              },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                productId: true,
                locationId: true,
                qty: true,
                uom: true,
                refId: true,
                createdAt: true,
                product: { select: { sku: true, name: true } },
                location: { select: { code: true, name: true } },
              },
            });
          }

          // Gabungkan & dedupe by id
          const map = new Map<string, (typeof primaryMoves)[number]>();
          for (const m of primaryMoves) map.set(m.id, m);
          for (const m of companions) map.set(m.id, m);
          allMoves = Array.from(map.values());
        }
      }

      // === Pairing OUT(-) dan IN(+) per (refId, productId, uom)
      type Row = {
        date: string;
        refId: string | null;
        productId: string;
        sku: string;
        name: string;
        uom: string;
        from?: { code: string; name: string };
        to?: { code: string; name: string };
        qty?: number; // absolute
        createdAt: string;
      };

      const keyOf = (m: any) =>
        `${m.refId ?? "NOREF"}::${m.productId}::${m.uom}`;
      const grouped = new Map<string, Row>();

      for (const m of allMoves) {
        const k = keyOf(m);
        if (!grouped.has(k)) {
          grouped.set(k, {
            date: m.createdAt.toISOString().slice(0, 10),
            refId: m.refId ?? null,
            productId: m.productId,
            sku: m.product.sku ?? "",
            name: m.product.name ?? "",
            uom: m.uom,
            createdAt: m.createdAt.toISOString(),
          });
        }
        const row = grouped.get(k)!;
        const qtyAbs = Math.abs(Number(m.qty));
        // Set FROM/TO & QTY
        if (Number(m.qty) < 0) {
          row.from = { code: m.location.code, name: m.location.name ?? "" };
          row.qty = row.qty ? Math.max(row.qty, qtyAbs) : qtyAbs;
        } else {
          row.to = { code: m.location.code, name: m.location.name ?? "" };
          row.qty = row.qty ? Math.max(row.qty, qtyAbs) : qtyAbs;
        }
        // Tanggal gunakan yang lebih awal
        if (new Date(row.createdAt).getTime() > m.createdAt.getTime()) {
          row.createdAt = m.createdAt.toISOString();
          row.date = row.createdAt.slice(0, 10);
        }
      }

      // Final rows
      let data = Array.from(grouped.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt)
      );

      // Kalau ada filter lokasi, tampilkan baris yang menyentuh lokasi tsb (from atau to)
      if (locationCode) {
        data = data.filter(
          (r) => r.from?.code === locationCode || r.to?.code === locationCode
        );
      }

      // Ringkasan total qty per hari (opsional)
      const summary = data.reduce<Record<string, number>>((acc, r) => {
        const k = r.date;
        acc[k] = (acc[k] ?? 0) + (r.qty ?? 0);
        return acc;
      }, {});

      const exportFmt = String(q.export || "").toLowerCase();

      // === EXPORT CSV ===
      if (exportFmt === "csv") {
        const headers = [
          "refId",
          "date",
          "sku",
          "name",
          "from",
          "to",
          "uom",
          "qty",
        ];

        const rowsCsv = (data as any[]).map((r) => ({
          refId: r.refId ?? "",
          date: r.date,
          sku: r.sku ?? "",
          name: r.name ?? "",
          from: r.from ? `${r.from.code} - ${r.from.name}` : "",
          to: r.to ? `${r.to.code} - ${r.to.name}` : "",
          uom: r.uom ?? "",
          qty: Number(r.qty ?? 0),
        }));

        const labelFrom = (q.date_from || "").trim();
        const labelTo = (q.date_to || "").trim();
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(
          reply,
          `transfers_${labelFrom || "ALL"}_${labelTo || "ALL"}.csv`,
          csv
        );
      }

      // === EXPORT PDF ===
      if (exportFmt === "pdf") {
        const brand = await loadStoreBrand();
        const labelFrom = (q.date_from || "").trim();
        const labelTo = (q.date_to || "").trim();
        const periodLabel =
          labelFrom && labelTo ? `${labelFrom} s/d ${labelTo}` : "Semua Waktu";

        const buf = await buildTransfersReportPdf({
          storeName: brand.storeName,
          periodLabel,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows: data.map((r) => ({
            date: r.date,
            refId: r.refId,
            sku: r.sku,
            name: r.name,
            from: r.from,
            to: r.to,
            uom: r.uom,
            qty: Number(r.qty ?? 0),
          })),
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="transfers_${labelFrom || "ALL"}_${
            labelTo || "ALL"
          }.pdf"`
        );
        return reply.send(buf);
      }

      // === JSON Default (tetap)
      return reply.send({
        ok: true,
        filter: {
          date_from: dateFrom?.toISOString() ?? null,
          date_to: dateTo?.toISOString() ?? null,
          productId: productId ?? null,
          locationCode: locationCode ?? null,
        },
        count: data.length,
        summaryPerDay: summary,
        data,
      });
    }
  );
}
