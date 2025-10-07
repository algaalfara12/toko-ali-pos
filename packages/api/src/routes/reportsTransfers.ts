import { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { requireRoles } from '../utils/roleGuard';

// helper: parse tanggal (YYYY-MM-DD) → Date range UTC harian
function dayStart(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0); }
function dayEnd(d: Date)   { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999); }
function parseISODate(s?: string): Date | undefined {
  if (!s) return;
  const [y,m,d] = s.split('-').map(Number);
  if (!y || !m || !d) return;
  return new Date(y, m-1, d);
}

export default async function reportsTransfersRoutes(app: FastifyInstance) {
  // GET /reports/stock/transfers?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&productId=&locationCode=
  app.get(
    '/reports/stock/transfers',
    { preHandler: [requireRoles(app, ['admin','petugas_gudang'])] },
    async (req, reply) => {
      const q = req.query as any;

      // rentang tanggal default: hari ini
      const df = parseISODate(q.date_from) ?? new Date();
      const dt = parseISODate(q.date_to)   ?? new Date();
      const dateFrom = dayStart(df);
      const dateTo   = dayEnd(dt);

      const productId = q.productId ? String(q.productId) : undefined;
      const locationCode = q.locationCode ? String(q.locationCode) : undefined;

      // kalau filter locationCode → dapatkan id
      let locationIdFilter: string | undefined;
      if (locationCode) {
        const loc = await prisma.location.findUnique({ where: { code: locationCode } });
        if (!loc) return reply.code(404).send({ ok:false, error:`Lokasi tidak ditemukan: ${locationCode}` });
        locationIdFilter = loc.id;
      }

      // Ambil SEMUA StockMove TRANSFER di rentang
      const where: any = {
        type: 'TRANSFER',
        createdAt: { gte: dateFrom, lte: dateTo },
      };
      if (productId) where.productId = productId;
      if (locationIdFilter) where.locationId = locationIdFilter;

      const moves = await prisma.stockMove.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, productId: true, locationId: true, qty: true, uom: true, refId: true, createdAt: true,
          product: { select: { sku: true, name: true } },
          location: { select: { code: true, name: true } }
        }
      });

      // Pairing OUT(-) dan IN(+) per (refId, productId, uom).
      // Catatan: jika ada move tanpa refId, kita treat sebagai baris tunggal (fallback).
      type Row = {
        date: string;
        refId: string | null;
        productId: string;
        sku: string;
        name: string;
        uom: string;
        from?: { code: string, name: string };
        to?:   { code: string, name: string };
        qty?: number; // absolute
        createdAt: string;
      };

      const keyOf = (m: any) => `${m.refId ?? 'NOREF'}::${m.productId}::${m.uom}`;
      const grouped = new Map<string, Row>();

      for (const m of moves) {
        const k = keyOf(m);
        if (!grouped.has(k)) {
          grouped.set(k, {
            date: m.createdAt.toISOString().slice(0,10),
            refId: m.refId ?? null,
            productId: m.productId,
            sku: m.product.sku,
            name: m.product.name,
            uom: m.uom,
            createdAt: m.createdAt.toISOString()
          });
        }
        const row = grouped.get(k)!;
        if (Number(m.qty) < 0) {
          row.from = { code: m.location.code, name: m.location.name };
          row.qty = Math.abs(Number(m.qty));
        } else {
          row.to = { code: m.location.code, name: m.location.name };
          row.qty = Math.abs(Number(m.qty));
        }
      }

      // Hanya baris yang punya minimal salah satu sisi (from/to). Normalnya, keduanya ada.
      const data = Array.from(grouped.values()).sort((a,b) => a.createdAt.localeCompare(b.createdAt));

      // Ringkasan total qty per hari (opsional)
      const summary = data.reduce<Record<string, number>>((acc, r) => {
        const k = r.date;
        acc[k] = (acc[k] ?? 0) + (r.qty ?? 0);
        return acc;
      }, {});

      return reply.send({
        ok: true,
        filter: {
          date_from: dateFrom.toISOString(),
          date_to: dateTo.toISOString(),
          productId: productId ?? null,
          locationCode: locationCode ?? null
        },
        count: data.length,
        summaryPerDay: summary,
        data
      });
    }
  );
}
