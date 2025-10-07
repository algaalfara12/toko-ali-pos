import { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';

/** Format YYYY-MM-DD dari komponen lokal (tanpa UTC shift) */
function fmtLocalYYYYMMDD(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Parse YYYY-MM-DD dan buat rentang 00:00:00–23:59:59 lokal */
function dayRange(dateStr?: string) {
  let base = new Date();
  if (dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    base = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0); // lokal midnight
  }
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const end   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start, end, label: fmtLocalYYYYMMDD(start) };
}

/** Ringkas list sale → {count, totalUang, totalItem} */
function summarize(list: any[]) {
  const totalUang = list.reduce((sum, s) => sum + Number(s.total ?? 0), 0);
  const totalItem = list.reduce(
    (sum, s) => sum + (Array.isArray(s.lines) ? s.lines.reduce((a: number, l: any) => a + Number(l.qty ?? 0), 0) : 0),
    0
  );
  return { count: list.length, totalUang, totalItem };
}

export default async function reportsRoutes(app: FastifyInstance) {
  // === Kasir: Laporan harian per kasir (detail + ringkasan CASH vs NON_CASH) ===
  // GET /reports/cashier/daily?date=YYYY-MM-DD&cashierId=xxx
  app.get('/reports/cashier/daily', async (req, reply) => {
    const q = req.query as any;
    const cashierId = q.cashierId as string | undefined;
    const dateStr   = q.date as string | undefined;
    const { start, end, label } = dayRange(dateStr);

    const where: any = { createdAt: { gte: start, lte: end } };
    if (cashierId) where.cashierId = cashierId;

    const sales = await prisma.sale.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { lines: true, payments: true }
    });

    // Normalisasi method → 'CASH' | 'NON_CASH'
    const CASH: any[] = [];
    const NON_CASH: any[] = [];
    for (const s of sales) {
      const key = String(s.method).toUpperCase() === 'NON_CASH' ? 'NON_CASH' : 'CASH';
      if (key === 'CASH') CASH.push(s); else NON_CASH.push(s);
    }

    const cashSum    = summarize(CASH);
    const nonCashSum = summarize(NON_CASH);
    const allSum = {
      count: (cashSum.count + nonCashSum.count),
      totalUang: (cashSum.totalUang + nonCashSum.totalUang),
      totalItem: (cashSum.totalItem + nonCashSum.totalItem),
    };

    // Rincian barang terjual (gabung semua line)
    const detailBarang = sales.flatMap(s => (s.lines || []).map(l => ({
      saleId: s.id,
      number: s.number,
      method: String(s.method).toUpperCase(),
      productId: l.productId,
      uom: l.uom,
      qty: Number(l.qty),
      price: Number(l.price),
      discount: Number(l.discount),
      subtotal: Number(l.subtotal),
      createdAt: s.createdAt
    })));

    return reply.send({
      ok: true,
      date: label,             // ← TANGGAL LOKAL (bukan ISO UTC)
      cashierId: cashierId ?? null,
      summary: {
        CASH: cashSum,
        NON_CASH: nonCashSum,
        ALL: allSum
      },
      sales: sales.map(s => ({
        id: s.id,
        number: s.number,
        method: String(s.method).toUpperCase(),
        total: Number(s.total),
        createdAt: s.createdAt,
        lines: (s.lines || []).map(l => ({
          productId: l.productId,
          uom: l.uom,
          qty: Number(l.qty),
          price: Number(l.price),
          discount: Number(l.discount),
          subtotal: Number(l.subtotal)
        }))
      })),
      detailBarang
    });
  });

  // === Admin: Rekap harian per kasir (CASH vs NON_CASH) ===
  // GET /reports/cashier/summary?date=YYYY-MM-DD
  app.get('/reports/cashier/summary', async (req, reply) => {
    const q = req.query as any;
    const dateStr = q.date as string | undefined;
    const { start, end, label } = dayRange(dateStr);

    const sales = await prisma.sale.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: { lines: true },
      orderBy: [{ cashierId: 'asc' }, { createdAt: 'asc' }]
    });

    const byCashier: Record<string, any[]> = {};
    for (const s of sales) {
      const key = s.cashierId || 'UNKNOWN';
      (byCashier[key] ||= []).push(s);
    }

    function summarizeList(list: any[]) {
      const cash    = list.filter(s => String(s.method).toUpperCase() === 'CASH');
      const noncash = list.filter(s => String(s.method).toUpperCase() === 'NON_CASH');
      return {
        CASH: summarize(cash),
        NON_CASH: summarize(noncash),
        ALL: {
          count: list.length,
          totalUang: summarize(cash).totalUang + summarize(noncash).totalUang,
          totalItem: summarize(cash).totalItem + summarize(noncash).totalItem
        }
      };
    }

    const rows = Object.entries(byCashier).map(([cashierId, list]) => ({
      cashierId,
      summary: summarizeList(list)
    }));

    return reply.send({
      ok: true,
      date: label,           // ← TANGGAL LOKAL
      cashierCount: rows.length,
      rows
    });
  });

  /** Parse range YYYY-MM-DD → YYYY-MM-DD (lokal) */
    function rangeOf(from?: string, to?: string) {
    const today = new Date();
    const start = from
        ? (() => { const [y,m,d]=from.split('-').map(Number); return new Date(y,(m??1)-1,(d??1),0,0,0,0); })()
        : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0,0,0,0);

    const end = to
        ? (() => { const [y,m,d]=to.split('-').map(Number); return new Date(y,(m??1)-1,(d??1),23,59,59,999); })()
        : new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23,59,59,999);

    return { start, end };
    }

    /** Group array by key function */
    function groupBy<T, K extends string | number>(arr: T[], keyFn: (x: T)=>K): Record<K, T[]> {
    return arr.reduce((acc, item) => {
        const k = keyFn(item);
        (acc[k] ||= []).push(item);
        return acc;
    }, {} as Record<K, T[]>);
    }

    /** Ringkas satu list sale jadi summary CASH/NON_CASH/ALL */
    function summarizeByMethod(list: any[]) {
    const cash    = list.filter(s => String(s.method).toUpperCase() === 'CASH');
    const noncash = list.filter(s => String(s.method).toUpperCase() === 'NON_CASH');

    const sumAmount = (arr: any[]) => arr.reduce((t, s) => t + Number(s.total ?? 0), 0);
    const sumItems  = (arr: any[]) => arr.reduce((t, s) => t + (Array.isArray(s.lines) ? s.lines.reduce((a:number,l:any)=> a + Number(l.qty ?? 0), 0) : 0), 0);

    const CASH =    { count: cash.length,    totalUang: sumAmount(cash),    totalItem: sumItems(cash) };
    const NON_CASH ={ count: noncash.length, totalUang: sumAmount(noncash), totalItem: sumItems(noncash) };
    const ALL =     { count: list.length,    totalUang: CASH.totalUang + NON_CASH.totalUang, totalItem: CASH.totalItem + NON_CASH.totalItem };

    return { CASH, NON_CASH, ALL };
    }

    // === Admin: Rekap range tanggal (harian/mingguan/bulanan) ===
    // GET /reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD[&cashierId=...]
    // Output: rows per-hari dengan summary CASH/NON_CASH/ALL dan total keseluruhan.
    app.get('/reports/range', async (req, reply) => {
    const q = req.query as any;
    const { start, end } = rangeOf(q.from as string | undefined, q.to as string | undefined);
    const cashierId = q.cashierId as string | undefined;

    const where: any = { createdAt: { gte: start, lte: end } };
    if (cashierId) where.cashierId = cashierId;

    const sales = await prisma.sale.findMany({
        where,
        include: { lines: true },
        orderBy: { createdAt: 'asc' }
    });

    // Kelompokkan per YYYY-MM-DD (lokal)
    const byDay = groupBy(sales, (s) => fmtLocalYYYYMMDD(new Date(s.createdAt)));

    const rows = Object.entries(byDay).map(([day, list]) => ({
        date: day,
        summary: summarizeByMethod(list)
    })).sort((a,b) => a.date.localeCompare(b.date));

    // Total keseluruhan range
    const allList = sales;
    const total = summarizeByMethod(allList);

    return reply.send({
        ok: true,
        from: fmtLocalYYYYMMDD(start),
        to: fmtLocalYYYYMMDD(end),
        cashierId: cashierId ?? null,
        days: rows.length,
        rows,
        total
    });
    });

}
