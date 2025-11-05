// packages/api/src/routes/reports.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildSalesReportPdf } from "../utils/pdf";
import { buildInflowReportPdf } from "../utils/pdf";
import { buildTopProductsPdf } from "../utils/pdf";
import dayjs from "dayjs";

/** Format YYYY-MM-DD dari komponen lokal (tanpa UTC shift) */
function fmtLocalYYYYMMDD(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Parse YYYY-MM-DD dan buat rentang 00:00:00–23:59:59 lokal */
function dayRange(dateStr?: string) {
  let base = new Date();
  if (dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    base = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0); // lokal midnight
  }
  const start = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    0,
    0,
    0,
    0
  );
  const end = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    23,
    59,
    59,
    999
  );
  return { start, end, label: fmtLocalYYYYMMDD(start) };
}

/** Group array by key function */
function groupBy<T, K extends string | number>(
  arr: T[],
  keyFn: (x: T) => K
): Record<K, T[]> {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] ||= []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

// ==== Helper StoreProfile + logo + timezone untuk PDF Sales ====
async function loadStoreBrandWithTz() {
  const sp = await prisma.storeProfile.findFirst();
  const brand = {
    storeName: sp?.name ?? "TOKO ALI POS",
    storeAddress: sp?.address ?? undefined,
    storePhone: sp?.phone ?? undefined,
    storeFooterNote: sp?.footerNote ?? undefined,
    logoUrl: sp?.logoUrl ?? undefined,
    timezone: sp?.timezone ?? "Asia/Jakarta",
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
function toLocalDateTimeLabel(d: Date, timeZone: string) {
  try {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    const fmt = new Intl.DateTimeFormat("id-ID", opts).formatToParts(d);
    const get = (type: string) => fmt.find((p) => p.type === type)?.value ?? "";
    const Y = get("year");
    const M = get("month");
    const D = get("day");
    const h = get("hour");
    const m = get("minute");
    return `${Y}-${M}-${D} ${h}:${m}`;
  } catch {
    return dayjs(d).format("YYYY-MM-DD HH:mm");
  }
}

/** Ringkas satu list sale jadi summary CASH/NON_CASH/ALL (referensi historis, dipakai di /reports/range) */
function summarizeByMethod(list: any[]) {
  const cash = list.filter((s) => String(s.method).toUpperCase() === "CASH");
  const noncash = list.filter(
    (s) => String(s.method).toUpperCase() === "NON_CASH"
  );

  const sumAmount = (arr: any[]) =>
    arr.reduce((t, s) => t + Number(s.total ?? 0), 0);
  const sumItems = (arr: any[]) =>
    arr.reduce(
      (t, s) =>
        t +
        (Array.isArray(s.lines)
          ? s.lines.reduce((a: number, l: any) => a + Number(l.qty ?? 0), 0)
          : 0),
      0
    );

  const CASH = {
    count: cash.length,
    totalUang: sumAmount(cash),
    totalItem: sumItems(cash),
  };
  const NON_CASH = {
    count: noncash.length,
    totalUang: sumAmount(noncash),
    totalItem: sumItems(noncash),
  };
  const ALL = {
    count: list.length,
    totalUang: CASH.totalUang + NON_CASH.totalUang,
    totalItem: CASH.totalItem + NON_CASH.totalItem,
  };

  return { CASH, NON_CASH, ALL };
}

export default async function reportsRoutes(app: FastifyInstance) {
  // ==========================================================
  // 1) KASIR/ADMIN: LAPORAN HARIAN PER KASIR (detail + ringkasan)
  //    GET /reports/cashier/daily?date=YYYY-MM-DD&cashierId=xxx
  //    RBAC: admin, kasir
  //    Catatan: dipakai untuk dashboard harian (JSON/CSV, TANPA PDF)
  //             Sinkron perhitungan dengan /reports/sales:
  //             - SALES dari Payment(kind='SALE')
  //             - REFUNDS dari Payment(kind='REFUND') berdasarkan tanggal retur
  //             - Kasir dibatasi ke miliknya sendiri (RBAC)
  // ==========================================================
  app.get(
    "/reports/cashier/daily",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date: z.string().optional(), // YYYY-MM-DD, default hari ini
        cashierId: z.string().uuid().optional(),
        export: z.string().optional(), // 'csv' untuk CSV
        view: z
          .enum(["sales", "refunds", "summary"])
          .optional()
          .default("sales"),
      });
      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const { date, cashierId, export: exportFmt, view } = p.data;

      // Range lokal 00:00–23:59 untuk parameter date (atau hari ini)
      const base = date
        ? (() => {
            const [y, m, d] = date.split("-").map(Number);
            return new Date(y, (m ?? 1) - 1, d ?? 1);
          })()
        : new Date();
      const start = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        0,
        0,
        0,
        0
      );
      const end = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        23,
        59,
        59,
        999
      );
      const label = `${start.getFullYear()}-${String(
        start.getMonth() + 1
      ).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;

      // RBAC: kasir hanya boleh lihat miliknya → override cashierId jika role=kasir
      const user = (req as any).user as { id: string; role: string };
      const cashierIdEffective =
        user.role === "kasir" ? user.id : cashierId ?? undefined;

      // 1) Ambil SALE pada rentang hari tsb (opsional filter per kasir)
      const saleWhere: any = { createdAt: { gte: start, lte: end } };
      if (cashierIdEffective) saleWhere.cashierId = cashierIdEffective;

      const sales = await prisma.sale.findMany({
        where: saleWhere,
        orderBy: { createdAt: "asc" },
        include: { lines: true }, // item count dari sini
      });

      // Kumpulkan saleIds & customerIds
      const saleIds = sales.map((s) => s.id);
      const customerIds = Array.from(
        new Set(sales.map((s) => s.customerId).filter(Boolean))
      ) as string[];

      // 2) Ambil PAYMENTS (SALE) untuk sales di atas (multi-payment aware)
      const salePays = saleIds.length
        ? await prisma.payment.findMany({
            where: { saleId: { in: saleIds }, kind: "SALE" },
            select: { saleId: true, method: true, amount: true },
          })
        : [];

      // 3) Ambil CUSTOMER info (mapping by id)
      const custMap = new Map<
        string,
        { id: string; name: string | null; memberCode: string | null }
      >();
      if (customerIds.length) {
        const custs = await prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true, memberCode: true },
        });
        for (const c of custs) custMap.set(c.id, c);
      }

      // 4) Ambil SALE RETURNS pada rentang hari tsb (refund dialokasikan ke tanggal retur)
      const returnWhere: any = { createdAt: { gte: start, lte: end } };
      if (cashierIdEffective) returnWhere.cashierId = cashierIdEffective;

      // include lines + product agar CSV refunds detail bisa menampilkan SKU/Name
      const returns = await prisma.saleReturn.findMany({
        where: returnWhere,
        orderBy: { createdAt: "asc" },
        include: {
          sale: { select: { customerId: true } },
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
        },
      });
      const returnIds = returns.map((r) => r.id);

      // Perluas custMap agar mencakup customer yang hanya muncul di returns
      const extraCustIds = Array.from(
        new Set(
          returns.map((r) => r.sale?.customerId).filter((x): x is string => !!x)
        )
      ).filter((id) => !custMap.has(id));
      if (extraCustIds.length) {
        const extraCusts = await prisma.customer.findMany({
          where: { id: { in: extraCustIds } },
          select: { id: true, name: true, memberCode: true },
        });
        for (const c of extraCusts) custMap.set(c.id, c);
      }

      // Ambil PAYMENTS (REFUND) utk returnIds tsb — TANPA filter by payment.createdAt
      const refundPays = returnIds.length
        ? await prisma.payment.findMany({
            where: { saleReturnId: { in: returnIds }, kind: "REFUND" },
            select: { saleReturnId: true, method: true, amount: true },
          })
        : [];

      // 5) Agregasi SALES per metode dari SALE payments
      const sumAmount = (arr: number[]) => arr.reduce((t, x) => t + x, 0);

      const bySaleId = saleIds.reduce((acc, id) => {
        acc[id] = { CASH: 0, NON_CASH: 0 };
        return acc;
      }, {} as Record<string, { CASH: number; NON_CASH: number }>);
      for (const pmt of salePays) {
        if (!bySaleId[pmt.saleId!])
          bySaleId[pmt.saleId!] = { CASH: 0, NON_CASH: 0 };
        bySaleId[pmt.saleId!][pmt.method] += Number(pmt.amount);
      }

      const allCashSales = sumAmount(
        Object.values(bySaleId).map((x) => x.CASH)
      );
      const allNonCashSales = sumAmount(
        Object.values(bySaleId).map((x) => x.NON_CASH)
      );
      const allSalesTotal = allCashSales + allNonCashSales;

      // 6) Agregasi REFUNDS per metode dari refundPays
      const refundByReturnId = returnIds.reduce((acc, id) => {
        acc[id] = { CASH: 0, NON_CASH: 0 };
        return acc;
      }, {} as Record<string, { CASH: number; NON_CASH: number }>);
      for (const pmt of refundPays) {
        if (!refundByReturnId[pmt.saleReturnId!])
          refundByReturnId[pmt.saleReturnId!] = { CASH: 0, NON_CASH: 0 };
        refundByReturnId[pmt.saleReturnId!][pmt.method] += Number(pmt.amount);
      }

      const refundCash = sumAmount(
        Object.values(refundByReturnId).map((x) => x.CASH)
      );
      const refundNonCash = sumAmount(
        Object.values(refundByReturnId).map((x) => x.NON_CASH)
      );
      const refundAll = refundCash + refundNonCash;

      // 7) Hitung item count dari sale.lines
      const totalItems = sales.reduce(
        (sum, s) =>
          sum + (s.lines?.reduce((a, l) => a + Number(l.qty ?? 0), 0) ?? 0),
        0
      );

      // 8) NETT setelah refund
      const net = {
        CASH: allCashSales - refundCash,
        NON_CASH: allNonCashSales - refundNonCash,
        ALL: allSalesTotal - refundAll,
      };

      // 9) Susun detail sales (dengan customerName & breakdown payment per-sale)
      const salesDetail = sales.map((s) => {
        const cx = s.customerId ? custMap.get(s.customerId) : undefined;
        const pay = bySaleId[s.id] ?? { CASH: 0, NON_CASH: 0 };
        return {
          id: s.id,
          number: s.number,
          customer: cx
            ? { id: cx.id, name: cx.name, memberCode: cx.memberCode }
            : null,
          payments: { CASH: pay.CASH, NON_CASH: pay.NON_CASH },
          total: Number(s.total),
          createdAt: s.createdAt,
          lines: (s.lines || []).map((l) => ({
            productId: l.productId,
            uom: l.uom,
            qty: Number(l.qty),
            price: Number(l.price),
            discount: Number(l.discount),
            subtotal: Number(l.subtotal),
          })),
        };
      });

      // 10) Susun detail refunds (per return)
      const returnsDetail = returns.map((r) => {
        const pay = refundByReturnId[r.id] ?? { CASH: 0, NON_CASH: 0 };
        return {
          returnId: r.id,
          number: r.number,
          payments: { CASH: pay.CASH, NON_CASH: pay.NON_CASH },
          refundTotal: pay.CASH + pay.NON_CASH,
          createdAt: r.createdAt,
        };
      });

      // 11) CSV export? (tanpa pembulatan)
      if ((exportFmt || "").toLowerCase() === "csv") {
        if (view === "summary") {
          const headers = [
            "date",
            "sales_cash",
            "sales_non_cash",
            "sales_all",
            "items",
            "refund_cash",
            "refund_non_cash",
            "refund_all",
            "nett_cash",
            "nett_non_cash",
            "nett_all",
          ];
          const rowsCsv = [
            {
              date: label,
              sales_cash: String(allCashSales),
              sales_non_cash: String(allNonCashSales),
              sales_all: String(allSalesTotal),
              items: String(totalItems),
              refund_cash: String(refundCash),
              refund_non_cash: String(refundNonCash),
              refund_all: String(refundAll),
              nett_cash: String(net.CASH),
              nett_non_cash: String(net.NON_CASH),
              nett_all: String(net.ALL),
            },
          ];
          const csv = toCsv(headers, rowsCsv);
          return sendCsv(reply, `cashier_daily_summary_${label}.csv`, csv);
        }

        if (view === "sales") {
          const headers = [
            "number",
            "customer",
            "memberCode",
            "cash_amount",
            "noncash_amount",
            "total",
            "createdAt",
          ];
          const rowsCsv = salesDetail.map((s) => ({
            number: s.number,
            customer: s.customer?.name ?? "",
            memberCode: s.customer?.memberCode ?? "",
            cash_amount: String(s.payments.CASH),
            noncash_amount: String(s.payments.NON_CASH),
            total: String(s.total),
            createdAt: s.createdAt.toISOString(),
          }));
          const csv = toCsv(headers, rowsCsv);
          return sendCsv(reply, `cashier_daily_sales_${label}.csv`, csv);
        }

        // view === "refunds" → per-baris retur + customer + product
        const headers = [
          "returnNumber",
          "customer",
          "memberCode",
          "sku",
          "productName",
          "uom",
          "qty",
          "refund_cash",
          "refund_noncash",
          "refund_total",
          "createdAt",
        ];
        const rowsCsv = returns.flatMap((r) => {
          const pay = refundByReturnId[r.id] ?? { CASH: 0, NON_CASH: 0 };
          const cust = r.sale?.customerId
            ? custMap.get(r.sale.customerId)
            : undefined;
          return (r.lines || []).map((l) => ({
            returnNumber: r.number,
            customer: cust?.name ?? "",
            memberCode: cust?.memberCode ?? "",
            sku: l.product?.sku ?? "",
            productName: l.product?.name ?? "",
            uom: l.uom,
            qty: String(Number(l.qty)),
            refund_cash: String(pay.CASH),
            refund_noncash: String(pay.NON_CASH),
            refund_total: String(pay.CASH + pay.NON_CASH),
            createdAt: r.createdAt.toISOString(),
          }));
        });
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(reply, `cashier_daily_refunds_${label}.csv`, csv);
      }

      // 12) JSON response (tanpa pembulatan)
      return reply.send({
        ok: true,
        date: label,
        cashierId: cashierIdEffective ?? null,
        summary: {
          SALES: {
            CASH: {
              amount: allCashSales,
              count: sales.length,
              totalItem: totalItems,
            },
            NON_CASH: { amount: allNonCashSales, count: 0, totalItem: 0 }, // count per-method tidak digunakan
            ALL: {
              amount: allSalesTotal,
              count: sales.length,
              totalItem: totalItems,
            },
          },
          REFUNDS: {
            CASH: refundCash,
            NON_CASH: refundNonCash,
            ALL: refundAll,
          },
          NETT: net,
        },
        sales: salesDetail,
        refunds: returnsDetail,
      });
    }
  );

  // ==========================================================
  // 2) ADMIN: REKAP HARIAN PER KASIR (CASH vs NON_CASH)
  //    GET /reports/cashier/summary?date=YYYY-MM-DD
  //    RBAC: admin
  // ==========================================================
  app.get(
    "/reports/cashier/summary",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const q = req.query as any;
      const dateStr = q.date as string | undefined;
      const exportFmt = (q.export as string | undefined)?.toLowerCase();

      const base = dateStr
        ? (() => {
            const [y, m, d] = dateStr.split("-").map(Number);
            return new Date(y, (m ?? 1) - 1, d ?? 1);
          })()
        : new Date();
      const start = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        0,
        0,
        0,
        0
      );
      const end = new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate(),
        23,
        59,
        59,
        999
      );
      const label = `${start.getFullYear()}-${String(
        start.getMonth() + 1
      ).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;

      const sales = await prisma.sale.findMany({
        where: { createdAt: { gte: start, lte: end } },
        include: { lines: true },
        orderBy: [{ cashierId: "asc" }, { createdAt: "asc" }],
      });
      const saleIds = sales.map((s) => s.id);
      const salePays = saleIds.length
        ? await prisma.payment.findMany({
            where: { saleId: { in: saleIds }, kind: "SALE" },
            select: { saleId: true, method: true, amount: true },
          })
        : [];

      const saleCashierMap = new Map<string, string>();
      for (const s of sales) saleCashierMap.set(s.id, s.cashierId);

      const salesByCashier: Record<
        string,
        { CASH: number; NON_CASH: number; items: number }
      > = {};
      for (const s of sales) {
        if (!salesByCashier[s.cashierId])
          salesByCashier[s.cashierId] = { CASH: 0, NON_CASH: 0, items: 0 };
        const items = (s.lines || []).reduce(
          (t, l) => t + Number(l.qty ?? 0),
          0
        );
        salesByCashier[s.cashierId].items += items;
      }
      for (const p of salePays) {
        const c = saleCashierMap.get(p.saleId!);
        if (!c) continue;
        if (!salesByCashier[c])
          salesByCashier[c] = { CASH: 0, NON_CASH: 0, items: 0 };
        salesByCashier[c][p.method] += Number(p.amount);
      }

      const returns = await prisma.saleReturn.findMany({
        where: { createdAt: { gte: start, lte: end } },
        select: { id: true, cashierId: true },
      });
      const returnIds = returns.map((r) => r.id);
      const refundPays = returnIds.length
        ? await prisma.payment.findMany({
            where: { saleReturnId: { in: returnIds }, kind: "REFUND" },
            select: { saleReturnId: true, method: true, amount: true },
          })
        : [];
      const retMap = new Map<string, string>();
      for (const r of returns) retMap.set(r.id, r.cashierId);

      const refundsByCashier: Record<
        string,
        { CASH: number; NON_CASH: number }
      > = {};
      for (const p of refundPays) {
        const c = retMap.get(p.saleReturnId!);
        if (!c) continue;
        if (!refundsByCashier[c])
          refundsByCashier[c] = { CASH: 0, NON_CASH: 0 };
        refundsByCashier[c][p.method] += Number(p.amount);
      }

      const cashierIds = Array.from(
        new Set([
          ...Object.keys(salesByCashier),
          ...Object.keys(refundsByCashier),
        ])
      );

      const rows = cashierIds.map((id) => {
        const S = salesByCashier[id] ?? { CASH: 0, NON_CASH: 0, items: 0 };
        const R = refundsByCashier[id] ?? { CASH: 0, NON_CASH: 0 };
        const salesAll = S.CASH + S.NON_CASH;
        const refundAll = R.CASH + R.NON_CASH;
        const NETT = {
          CASH: S.CASH - R.CASH,
          NON_CASH: S.NON_CASH - R.NON_CASH,
          ALL: salesAll - refundAll,
        };
        return { cashierId: id, summary: { SALES: S, REFUNDS: R, NETT } };
      });

      if (exportFmt === "csv") {
        const headers = [
          "date",
          "cashierId",
          "sales_cash",
          "sales_noncash",
          "sales_all",
          "items",
          "refund_cash",
          "refund_noncash",
          "refund_all",
          "nett_cash",
          "nett_noncash",
          "nett_all",
        ];
        const csvRows = rows.map((r) => ({
          date: label,
          cashierId: r.cashierId,
          sales_cash: String(r.summary.SALES.CASH),
          sales_noncash: String(r.summary.SALES.NON_CASH),
          sales_all: String(r.summary.SALES.CASH + r.summary.SALES.NON_CASH),
          items: String(r.summary.SALES.items),
          refund_cash: String(r.summary.REFUNDS.CASH),
          refund_noncash: String(r.summary.REFUNDS.NON_CASH),
          refund_all: String(
            r.summary.REFUNDS.CASH + r.summary.REFUNDS.NON_CASH
          ),
          nett_cash: String(r.summary.NETT.CASH),
          nett_noncash: String(r.summary.NETT.NON_CASH),
          nett_all: String(r.summary.NETT.ALL),
        }));
        const csv = toCsv(headers, csvRows);
        return sendCsv(reply, `cashier_summary_${label}.csv`, csv);
      }

      return reply.send({
        ok: true,
        date: label,
        cashierCount: rows.length,
        rows,
      });
    }
  );

  // ==========================================================
  // 3) ADMIN: REKAP RANGE TANGGAL
  //    GET /reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD[&cashierId=...]
  //    RBAC: admin
  // ==========================================================
  app.get(
    "/reports/range",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const q = req.query as any;
      const today = new Date();
      const start = q.from
        ? (() => {
            const [y, m, d] = (q.from as string).split("-").map(Number);
            return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
          })()
        : new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate(),
            0,
            0,
            0,
            0
          );
      const end = q.to
        ? (() => {
            const [y, m, d] = (q.to as string).split("-").map(Number);
            return new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
          })()
        : new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate(),
            23,
            59,
            59,
            999
          );
      const cashierId = q.cashierId as string | undefined;

      const where: any = { createdAt: { gte: start, lte: end } };
      if (cashierId) where.cashierId = cashierId;

      const sales = await prisma.sale.findMany({
        where,
        include: { lines: true },
        orderBy: { createdAt: "asc" },
      });

      // Kelompokkan per YYYY-MM-DD (lokal)
      const byDay = groupBy(sales, (s) =>
        fmtLocalYYYYMMDD(new Date(s.createdAt))
      );

      const rows = Object.entries(byDay)
        .map(([day, list]) => ({
          date: day,
          summary: summarizeByMethod(list),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

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
        total,
      });
    }
  );

  // ==========================================================
  // 4) SALES (periode fleksibel) — JSON/CSV/PDF
  //    GET /reports/sales?date_from&date_to[&cashierId][&method][&q][&detail][&page=&pageSize=][&export=csv|pdf]
  //    RBAC: admin, kasir
  // ==========================================================
  app.get(
    "/reports/sales",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().min(10, "date_from wajib (YYYY-MM-DD)"),
        date_to: z.string().min(10, "date_to wajib (YYYY-MM-DD)"),
        cashierId: z.string().optional(),
        method: z.enum(["CASH", "NON_CASH"]).optional(),
        q: z.string().optional(),
        detail: z.coerce.boolean().optional().default(false),
        page: z.coerce.number().int().positive().optional().default(1),
        pageSize: z.coerce
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20),
        export: z.string().optional(), // 'csv' | 'pdf'
      });

      const parsed = Q.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });
      }
      const {
        date_from,
        date_to,
        cashierId,
        method,
        q,
        detail,
        page,
        pageSize,
        export: exportFmtRaw,
      } = parsed.data;

      const exportFmt = (exportFmtRaw ?? "").toLowerCase();
      const df = new Date(date_from + "T00:00:00");
      const dt = new Date(date_to + "T23:59:59.999");
      if (isNaN(df.getTime()) || isNaN(dt.getTime())) {
        return reply
          .code(400)
          .send({ ok: false, error: "date_from/date_to invalid" });
      }

      // RBAC
      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      const cashierFilter =
        user.role === "kasir"
          ? { cashierId: user.id }
          : cashierId
          ? { cashierId }
          : undefined;

      // Base sales (filter tanggal & kasir)
      const baseSales = await prisma.sale.findMany({
        where: { createdAt: { gte: df, lte: dt }, ...(cashierFilter ?? {}) },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          number: true,
          createdAt: true,
          cashierId: true,
          customerId: true,
          subtotal: true,
          discount: true,
          tax: true,
          total: true,
          paid: true,
          change: true,
        },
      });
      const allSaleIds = baseSales.map((s) => s.id);

      // Payment SALE
      const pays = allSaleIds.length
        ? await prisma.payment.findMany({
            where: { saleId: { in: allSaleIds }, kind: "SALE" },
            select: { saleId: true, method: true, amount: true },
          })
        : [];
      const payBySale: Record<string, { CASH: number; NON_CASH: number }> = {};
      for (const s of allSaleIds) payBySale[s] = { CASH: 0, NON_CASH: 0 };
      for (const p of pays) {
        const rec =
          payBySale[p.saleId!] ||
          (payBySale[p.saleId!] = { CASH: 0, NON_CASH: 0 });
        rec[p.method] += Number(p.amount);
      }

      // Filter by method (SALE)
      let filteredIdsByMethod = allSaleIds;
      if (method) {
        filteredIdsByMethod = allSaleIds.filter(
          (id) => (payBySale[id]?.[method] ?? 0) > 0
        );
      }

      // Filter q (number/sku/name/uom)
      let filteredIdsAfterQ = filteredIdsByMethod;
      if (q && filteredIdsByMethod.length) {
        const qLower = q.toLowerCase();
        const salesForQ = await prisma.sale.findMany({
          where: { id: { in: filteredIdsByMethod } },
          select: {
            id: true,
            number: true,
            createdAt: true,
            lines: {
              select: {
                uom: true,
                product: { select: { sku: true, name: true } },
              },
            },
          },
        });
        filteredIdsAfterQ = salesForQ
          .filter((s) => {
            if (s.number.toLowerCase().includes(qLower)) return true;
            const ls = (s.lines ?? []) as any[];
            return ls.some(
              (l) =>
                l.product?.sku?.toLowerCase().includes(qLower) ||
                l.product?.name?.toLowerCase().includes(qLower) ||
                l.uom?.toLowerCase().includes(qLower)
            );
          })
          .map((s) => s.id);
      }

      const finalIds = filteredIdsAfterQ;

      // Summary payment totals (sesuai filter)
      let sumCash = 0,
        sumNonCash = 0,
        sumAll = 0;
      for (const id of finalIds) {
        const p = payBySale[id] ?? { CASH: 0, NON_CASH: 0 };
        sumCash += p.CASH;
        sumNonCash += p.NON_CASH;
        sumAll += p.CASH + p.NON_CASH;
      }

      // ===========================
      //        EXPORT = PDF
      // ===========================
      if ((exportFmt ?? "").toLowerCase() === "pdf") {
        // 1) Ambil seluruh results sesuai filter (TANPA paging), selalu include lines
        const allRows = finalIds.length
          ? await prisma.sale.findMany({
              where: { id: { in: finalIds } },
              orderBy: { createdAt: "asc" },
              include: {
                cashier: { select: { id: true, username: true } },
                customer: {
                  select: { id: true, name: true, memberCode: true },
                },
                lines: {
                  include: { product: { select: { sku: true, name: true } } },
                },
              },
            })
          : [];

        // 2) Ringkasan pembayaran (sudah dihitung: sumCash/sumNonCash/sumAll)
        // 3) Hitung refunds untuk periode & filter kasir yang sama
        const returns = await prisma.saleReturn.findMany({
          where: {
            createdAt: { gte: df, lte: dt },
            ...(user.role === "kasir"
              ? { cashierId: user.id }
              : cashierId
              ? { cashierId }
              : {}),
          },
          select: { id: true },
        });
        const returnIds = returns.map((r) => r.id);
        const refundPays = returnIds.length
          ? await prisma.payment.findMany({
              where: { saleReturnId: { in: returnIds }, kind: "REFUND" },
              select: { method: true, amount: true },
            })
          : [];
        const refundCash = refundPays
          .filter((p) => p.method === "CASH")
          .reduce((s, p) => s + Number(p.amount), 0);
        const refundNonCash = refundPays
          .filter((p) => p.method === "NON_CASH")
          .reduce((s, p) => s + Number(p.amount), 0);
        const refundAll = refundCash + refundNonCash;

        const summary = {
          salesCash: sumCash,
          salesNonCash: sumNonCash,
          salesAll: sumAll,
          refundCash,
          refundNonCash,
          refundAll,
          nettCash: sumCash - refundCash,
          nettNonCash: sumNonCash - refundNonCash,
          nettAll: sumAll - refundAll,
        };

        // 4) Susun rows untuk PDF
        const tzBrand = await loadStoreBrandWithTz();
        const rowsPdf = allRows.map((r) => {
          const pay = payBySale[r.id] ?? { CASH: 0, NON_CASH: 0 };
          const items = (r.lines || []).map((l) => ({
            sku: l.product?.sku ?? null,
            name: l.product?.name ?? "",
            uom: l.uom,
            qty: Number(l.qty),
            price: Number(l.price),
            discount: Number(l.discount),
            subtotal: Number(l.subtotal),
          }));
          return {
            number: r.number,
            createdAt: r.createdAt, // labelnya akan diformat oleh PDF builder
            cashierUsername: r.cashier?.username ?? r.cashierId,
            customerName: r.customer?.name ?? null,
            memberCode: r.customer?.memberCode ?? null,
            items,
            payments: { CASH: pay.CASH, NON_CASH: pay.NON_CASH },
            total: Number(r.total),
          };
        });

        // 5) Build PDF
        const buf = await buildSalesReportPdf({
          storeName: tzBrand.storeName,
          periodLabel: `${date_from} s/d ${date_to}`,
          storeLogoBuffer: tzBrand.storeLogoBuffer,
          storeFooterNote: tzBrand.storeFooterNote,
          summary,
          rows: rowsPdf,
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="sales_${date_from}_${date_to}.pdf"`
        );
        return reply.send(buf);
      }

      // ====== (Lanjut) Paging untuk JSON/CSV ======
      const skip = (page - 1) * pageSize;
      const pageIds = finalIds.slice(skip, skip + pageSize);
      const rows = pageIds.length
        ? await prisma.sale.findMany({
            where: { id: { in: pageIds } },
            orderBy: { createdAt: "desc" },
            include: {
              cashier: { select: { id: true, username: true, role: true } },
              customer: { select: { id: true, name: true, memberCode: true } },
              ...(detail
                ? {
                    lines: {
                      include: {
                        product: { select: { sku: true, name: true } },
                      },
                    },
                  }
                : {}),
            },
          })
        : [];

      const data = rows.map((r) => {
        const p = payBySale[r.id] ?? { CASH: 0, NON_CASH: 0 };
        const totalForFilter = method ? p[method] : p.CASH + p.NON_CASH;
        return {
          id: r.id,
          number: r.number,
          cashier: {
            id: r.cashier?.id ?? r.cashierId,
            username: r.cashier?.username ?? r.cashierId,
          },
          customer: r.customer
            ? {
                id: r.customer.id,
                name: r.customer.name,
                memberCode: r.customer.memberCode,
              }
            : null,
          payments: { CASH: p.CASH, NON_CASH: p.NON_CASH },
          totalForFilter,
          subtotal: Number(r.subtotal),
          discount: Number(r.discount),
          tax: Number(r.tax),
          total: Number(r.total),
          paid: Number(r.paid),
          change: Number(r.change),
          createdAt: r.createdAt,
          ...(detail
            ? {
                lines:
                  (r as any).lines?.map((l: any) => ({
                    productId: l.productId,
                    sku: l.product?.sku,
                    name: l.product?.name,
                    uom: l.uom,
                    qty: Number(l.qty),
                    price: Number(l.price),
                    discount: Number(l.discount),
                    subtotal: Number(l.subtotal),
                  })) ?? [],
              }
            : {}),
        };
      });

      // ====== EXPORT: CSV ======
      if (exportFmt === "csv") {
        if (!detail) {
          const headers = [
            "number",
            "cashier",
            "customer",
            "memberCode",
            "cash_amount",
            "noncash_amount",
            "total_for_filter",
            "createdAt",
          ];
          const rowsCsv = data.map((r) => ({
            number: r.number,
            cashier: r.cashier?.username ?? "",
            customer: r.customer?.name ?? "",
            memberCode: r.customer?.memberCode ?? "",
            cash_amount: String(r.payments.CASH),
            noncash_amount: String(r.payments.NON_CASH),
            total_for_filter: String(r.totalForFilter),
            createdAt: r.createdAt.toISOString(),
          }));
          const csv = toCsv(headers, rowsCsv);
          return sendCsv(reply, `sales_${date_from}_${date_to}.csv`, csv);
        } else {
          const headers = [
            "number",
            "cashier",
            "customer",
            "memberCode",
            "cash_amount",
            "noncash_amount",
            "total_for_filter",
            "sku",
            "name",
            "uom",
            "qty",
            "price",
            "discount",
            "subtotal",
            "createdAt",
          ];
          const rowsCsv = data.flatMap((r) =>
            (r.lines ?? []).map((l) => ({
              number: r.number,
              cashier: r.cashier?.username ?? "",
              customer: r.customer?.name ?? "",
              memberCode: r.customer?.memberCode ?? "",
              cash_amount: String(r.payments.CASH),
              noncash_amount: String(r.payments.NON_CASH),
              total_for_filter: String(r.totalForFilter),
              sku: l.sku ?? "",
              name: l.name ?? "",
              uom: l.uom,
              qty: String(l.qty),
              price: String(l.price),
              discount: String(l.discount),
              subtotal: String(l.subtotal),
              createdAt: r.createdAt.toISOString(),
            }))
          );
          const csv = toCsv(headers, rowsCsv);
          return sendCsv(
            reply,
            `sales_detail_${date_from}_${date_to}.csv`,
            csv
          );
        }
      }

      // ====== JSON default ======
      return reply.send({
        ok: true,
        page,
        pageSize,
        total: finalIds.length,
        summary: {
          payments: {
            CASH: sumCash,
            NON_CASH: sumNonCash,
            ALL: sumAll,
          },
          totalForFilter:
            method === "CASH"
              ? sumCash
              : method === "NON_CASH"
              ? sumNonCash
              : sumAll,
        },
        data,
      });
    }
  );

  // === Laporan Barang Terlaris ===
  app.get(
    "/reports/top-products",
    { preHandler: [requireRoles(app, ["admin"])] }, // ADMIN ONLY
    async (req, reply) => {
      const qschema = z.object({
        date_from: z.string().min(10).optional(), // boleh kosong → all-time
        date_to: z.string().min(10).optional(),
        cashierId: z.string().uuid().optional(), // optional: filter per kasir
        limit: z.coerce.number().int().positive().max(100).default(10),
        sortBy: z.enum(["qty", "revenue"]).default("qty"),
        groupByUom: z.coerce.boolean().optional().default(false),
        export: z.string().optional(), // "pdf" | "csv"
      });

      const parsed = qschema.safeParse(req.query);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });

      const {
        date_from,
        date_to,
        cashierId,
        limit,
        sortBy,
        groupByUom,
        export: exportFmtRaw,
      } = parsed.data;
      const exportFmt = (exportFmtRaw ?? "").toLowerCase();

      // Rentang waktu (local) — jika tidak ada → all time
      const df = date_from ? new Date(date_from + "T00:00:00") : null;
      const dt = date_to ? new Date(date_to + "T23:59:59.999") : null;
      if ((df && isNaN(df.getTime())) || (dt && isNaN(dt.getTime()))) {
        return reply
          .code(400)
          .send({ ok: false, error: "date_from/date_to invalid" });
      }

      // =========================
      //   SALE LINES (header: sale)
      // =========================
      const saleWhere: any = {};
      if (df && dt) saleWhere.createdAt = { gte: df, lte: dt };
      if (cashierId) saleWhere.cashierId = cashierId;

      const saleLines = await prisma.saleLine.findMany({
        where: { sale: saleWhere },
        include: {
          product: {
            select: { id: true, sku: true, name: true, baseUom: true },
          },
          sale: { select: { id: true } },
        },
      });

      // =========================
      //   RETURN LINES (header: ret)
      //   NOTE: relasi bernama 'ret', BUKAN 'saleReturn'
      // =========================
      const retWhere: any = {};
      if (df && dt) retWhere.createdAt = { gte: df, lte: dt };
      if (cashierId) retWhere.cashierId = cashierId;

      const retLines = await prisma.saleReturnLine.findMany({
        where: { ret: retWhere },
        include: {
          product: {
            select: { id: true, sku: true, name: true, baseUom: true },
          },
          ret: { select: { id: true } }, // <- perbaikan include
        },
      });

      // ===== Konversi UOM ke base untuk keduanya =====
      const productIds = Array.from(
        new Set([
          ...saleLines.map((l) => l.productId),
          ...retLines.map((l) => l.productId),
        ])
      );
      const uoms = await prisma.productUom.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, uom: true, toBase: true },
      });
      const toBase = new Map<string, number>(); // key = pid::uom
      for (const u of uoms) toBase.set(`${u.productId}::${u.uom}`, u.toBase);

      type AggRow = {
        productId: string;
        sku?: string | null;
        name?: string | null;
        baseUom?: string | null;
        saleQtyBase: number;
        saleRevenue: number;
        retQtyBase: number;
        retRevenue: number;
      };

      const agg = new Map<string, AggRow>();

      // ---- Kumpulkan SALE
      for (const l of saleLines) {
        const tb = toBase.get(`${l.productId}::${l.uom}`);
        if (!tb) continue;
        const key = l.productId;
        if (!agg.has(key)) {
          agg.set(key, {
            productId: l.productId,
            sku: l.product?.sku,
            name: l.product?.name,
            baseUom: l.product?.baseUom,
            saleQtyBase: 0,
            saleRevenue: 0,
            retQtyBase: 0,
            retRevenue: 0,
          });
        }
        const row = agg.get(key)!;
        row.saleQtyBase += Number(l.qty) * tb;
        row.saleRevenue += Number(l.subtotal);
      }

      // ---- Kumpulkan RETURNS (kurangi)
      for (const l of retLines) {
        const tb = toBase.get(`${l.productId}::${l.uom}`);
        if (!tb) continue;
        const key = l.productId;
        if (!agg.has(key)) {
          agg.set(key, {
            productId: l.productId,
            sku: l.product?.sku,
            name: l.product?.name,
            baseUom: l.product?.baseUom,
            saleQtyBase: 0,
            saleRevenue: 0,
            retQtyBase: 0,
            retRevenue: 0,
          });
        }
        const row = agg.get(key)!;
        row.retQtyBase += Number(l.qty) * tb;
        row.retRevenue += Number(l.subtotal);
      }

      // ---- Hasil NET = sale - return (clamp >= 0)
      let result = Array.from(agg.values()).map((r) => {
        const netQty = Math.max(0, r.saleQtyBase - r.retQtyBase);
        const netRevenue = Math.max(0, r.saleRevenue - r.retRevenue);
        return {
          productId: r.productId,
          sku: r.sku,
          name: r.name,
          baseUom: r.baseUom,
          qtyBase: netQty,
          revenue: netRevenue,
          saleQtyBase: r.saleQtyBase,
          saleRevenue: r.saleRevenue,
          returnQtyBase: r.retQtyBase,
          returnRevenue: r.retRevenue,
        };
      });

      // Sortir (NET)
      result.sort(
        sortBy === "revenue"
          ? (a, b) => b.revenue - a.revenue
          : (a, b) => b.qtyBase - a.qtyBase
      );
      result = result.slice(0, limit);

      // ===== EXPORT PDF =====
      if (exportFmt === "pdf") {
        const brand = await prisma.storeProfile.findFirst();
        let logoBuf: Buffer | undefined;
        if (brand?.logoUrl) {
          try {
            const r = await fetch(brand.logoUrl);
            if (r.ok) {
              const arr = await r.arrayBuffer();
              logoBuf = Buffer.from(arr);
            }
          } catch {}
        }
        const periodLabel =
          date_from && date_to ? `${date_from} s/d ${date_to}` : "All Time";

        const buf = await buildTopProductsPdf({
          storeName: brand?.name ?? "TOKO ALI POS",
          periodLabel,
          storeLogoBuffer: logoBuf,
          storeFooterNote: brand?.footerNote ?? undefined,
          sortBy,
          rows: result,
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="top_products_${date_from || "ALL"}_${
            date_to || "ALL"
          }.pdf"`
        );
        return reply.send(buf);
      }

      // ===== EXPORT CSV =====
      if (exportFmt === "csv") {
        const headers = [
          "sku",
          "name",
          "baseUom",
          "qtyBase", // NET
          "revenue", // NET
          "saleQtyBase",
          "returnQtyBase",
          "saleRevenue",
          "returnRevenue",
        ];
        const rowsCsv = result.map((r) => ({
          sku: r.sku ?? "",
          name: r.name ?? "",
          baseUom: r.baseUom ?? "",
          qtyBase: String(Math.round(r.qtyBase)),
          revenue: String(Math.round(r.revenue)),
          saleQtyBase: String(Math.round(r.saleQtyBase)),
          returnQtyBase: String(Math.round(r.returnQtyBase)),
          saleRevenue: String(Math.round(r.saleRevenue)),
          returnRevenue: String(Math.round(r.returnRevenue)),
        }));
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(
          reply,
          `top_products_${date_from || "ALL"}_${date_to || "ALL"}.csv`,
          csv
        );
      }

      // ===== JSON =====
      return reply.send({
        ok: true,
        from: date_from ?? null,
        to: date_to ?? null,
        limit,
        sortBy,
        count: result.length,
        data: result,
      });
    }
  );

  app.get(
    "/reports/inflow",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().min(10),
        date_to: z.string().min(10),
        cashierId: z.string().uuid().optional(),
        groupBy: z.coerce.boolean().optional().default(false),
        export: z.string().optional(), // 'csv' | 'pdf'
      });

      const pr = Q.safeParse(req.query);
      if (!pr.success) {
        return reply.code(400).send({ ok: false, error: pr.error.flatten() });
      }
      const {
        date_from,
        date_to,
        cashierId,
        groupBy,
        export: exportFmtRaw,
      } = pr.data;
      const exportFmt = (exportFmtRaw ?? "").toLowerCase();

      const df = new Date(date_from + "T00:00:00");
      const dt = new Date(date_to + "T23:59:59.999");
      if (isNaN(df.getTime()) || isNaN(dt.getTime())) {
        return reply
          .code(400)
          .send({ ok: false, error: "date_from/date_to invalid" });
      }

      // RBAC
      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      const isAdmin = user.role === "admin";

      // Resolve filter kasir: kasir = paksa dirinya; admin = boleh tentukan cashierId
      const cashierFilter = !isAdmin
        ? { onlyIds: [user.id], forceSelf: true }
        : cashierId
        ? { onlyIds: [cashierId], forceSelf: false }
        : { onlyIds: undefined as string[] | undefined, forceSelf: false };

      // 1) Ambil SALE dalam range (hanya untuk dapat mapping saleId -> cashierId)
      const sales = await prisma.sale.findMany({
        where: { createdAt: { gte: df, lte: dt } },
        select: { id: true, cashierId: true },
      });

      // Filter kasir (jika admin memilih satu kasir atau kasir role)
      const salesFiltered = cashierFilter.onlyIds
        ? sales.filter((s) => cashierFilter.onlyIds!.includes(s.cashierId))
        : sales;

      const saleIdToCashier = new Map<string, string>();
      for (const s of salesFiltered) saleIdToCashier.set(s.id, s.cashierId);

      // 2) Ambil payments SALE untuk saleIds di atas
      const saleIds = Array.from(saleIdToCashier.keys());
      const salePays = saleIds.length
        ? await prisma.payment.findMany({
            where: { saleId: { in: saleIds }, kind: "SALE" },
            select: { saleId: true, method: true, amount: true },
          })
        : [];

      // 3) Ambil returns pada range (untuk mapping returnId -> cashierId)
      const returns = await prisma.saleReturn.findMany({
        where: { createdAt: { gte: df, lte: dt } },
        select: { id: true, cashierId: true },
      });
      const returnsFiltered = cashierFilter.onlyIds
        ? returns.filter((r) => cashierFilter.onlyIds!.includes(r.cashierId))
        : returns;

      const returnIdToCashier = new Map<string, string>();
      for (const r of returnsFiltered) returnIdToCashier.set(r.id, r.cashierId);

      // 4) Ambil payments REFUND untuk returns di atas
      const returnIds = Array.from(returnIdToCashier.keys());
      const refundPays = returnIds.length
        ? await prisma.payment.findMany({
            where: { saleReturnId: { in: returnIds }, kind: "REFUND" },
            select: { saleReturnId: true, method: true, amount: true },
          })
        : [];

      // 5) Akumulasi per-kasir
      type Sums = {
        salesCash: number;
        salesNonCash: number;
        refundCash: number;
        refundNonCash: number;
      };
      const byCashier: Record<string, Sums> = {};

      const addSum = (cid: string) =>
        (byCashier[cid] ||= {
          salesCash: 0,
          salesNonCash: 0,
          refundCash: 0,
          refundNonCash: 0,
        });

      for (const p of salePays) {
        const cid = saleIdToCashier.get(p.saleId!)!;
        const rec = addSum(cid);
        if (p.method === "CASH") rec.salesCash += Number(p.amount);
        else if (p.method === "NON_CASH") rec.salesNonCash += Number(p.amount);
      }

      for (const p of refundPays) {
        const cid = returnIdToCashier.get(p.saleReturnId!)!;
        const rec = addSum(cid);
        if (p.method === "CASH") rec.refundCash += Number(p.amount);
        else if (p.method === "NON_CASH") rec.refundNonCash += Number(p.amount);
      }

      // 6) Tentukan rows output
      let rowsOut: Array<{
        cashierId?: string | null;
        cashierUsername: string;
        salesCash: number;
        salesNonCash: number;
        refundCash: number;
        refundNonCash: number;
        nettCash: number;
        nettNonCash: number;
        nettAll: number;
      }> = [];

      // ambil username untuk kasir-kasir yang ada
      const cashierIds = Object.keys(byCashier);
      const usersMap = new Map<string, { id: string; username: string }>();
      if (cashierIds.length) {
        const users = await prisma.user.findMany({
          where: { id: { in: cashierIds } },
          select: { id: true, username: true },
        });
        for (const u of users)
          usersMap.set(u.id, { id: u.id, username: u.username });
      }

      if (isAdmin && !cashierFilter.onlyIds && groupBy) {
        // admin, semua kasir, minta groupBy
        rowsOut = cashierIds.map((cid) => {
          const s = byCashier[cid];
          const nettCash = s.salesCash - s.refundCash;
          const nettNonCash = s.salesNonCash - s.refundNonCash;
          return {
            cashierId: cid,
            cashierUsername: usersMap.get(cid)?.username ?? cid,
            salesCash: s.salesCash,
            salesNonCash: s.salesNonCash,
            refundCash: s.refundCash,
            refundNonCash: s.refundNonCash,
            nettCash,
            nettNonCash,
            nettAll: nettCash + nettNonCash,
          };
        });
      } else {
        // single row: untuk kasir role, atau admin dengan cashierId, atau admin tanpa groupBy
        let sum: Sums = {
          salesCash: 0,
          salesNonCash: 0,
          refundCash: 0,
          refundNonCash: 0,
        };
        if (cashierFilter.onlyIds) {
          for (const cid of cashierFilter.onlyIds) {
            const s = byCashier[cid];
            if (!s) continue;
            sum.salesCash += s.salesCash;
            sum.salesNonCash += s.salesNonCash;
            sum.refundCash += s.refundCash;
            sum.refundNonCash += s.refundNonCash;
          }
        } else {
          // gabungan semua kasir
          for (const cid of cashierIds) {
            const s = byCashier[cid];
            sum.salesCash += s.salesCash;
            sum.salesNonCash += s.salesNonCash;
            sum.refundCash += s.refundCash;
            sum.refundNonCash += s.refundNonCash;
          }
        }
        const nettCash = sum.salesCash - sum.refundCash;
        const nettNonCash = sum.salesNonCash - sum.refundNonCash;

        let label = "ALL";
        if (!isAdmin) {
          label = usersMap.get(user.id)?.username ?? user.username ?? user.id;
        } else if (
          cashierFilter.onlyIds &&
          cashierFilter.onlyIds.length === 1
        ) {
          const cid = cashierFilter.onlyIds[0];
          label = usersMap.get(cid)?.username ?? cid;
        }

        rowsOut = [
          {
            cashierId: !isAdmin ? user.id : cashierFilter.onlyIds?.[0] ?? null,
            cashierUsername: label,
            salesCash: sum.salesCash,
            salesNonCash: sum.salesNonCash,
            refundCash: sum.refundCash,
            refundNonCash: sum.refundNonCash,
            nettCash,
            nettNonCash,
            nettAll: nettCash + nettNonCash,
          },
        ];
      }

      // 7) Grand total
      const grand = rowsOut.reduce(
        (acc, r) => {
          acc.salesCash += r.salesCash;
          acc.salesNonCash += r.salesNonCash;
          acc.refundCash += r.refundCash;
          acc.refundNonCash += r.refundNonCash;
          acc.nettCash += r.nettCash;
          acc.nettNonCash += r.nettNonCash;
          acc.nettAll += r.nettAll;
          return acc;
        },
        {
          salesCash: 0,
          salesNonCash: 0,
          refundCash: 0,
          refundNonCash: 0,
          nettCash: 0,
          nettNonCash: 0,
          nettAll: 0,
        }
      );

      // 8) EXPORT: CSV
      if (exportFmt === "csv") {
        const headers = [
          "cashierUsername",
          "sales_cash",
          "sales_noncash",
          "refund_cash",
          "refund_noncash",
          "nett_cash",
          "nett_noncash",
          "nett_all",
          "date_from",
          "date_to",
        ];
        const rowsCsv = rowsOut.map((r) => ({
          cashierUsername: r.cashierUsername,
          sales_cash: String(r.salesCash),
          sales_noncash: String(r.salesNonCash),
          refund_cash: String(r.refundCash),
          refund_noncash: String(r.refundNonCash),
          nett_cash: String(r.nettCash),
          nett_noncash: String(r.nettNonCash),
          nett_all: String(r.nettAll),
          date_from,
          date_to,
        }));
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(reply, `inflow_${date_from}_${date_to}.csv`, csv);
      }

      // 9) EXPORT: PDF
      if (exportFmt === "pdf") {
        const brand = await loadStoreBrandWithTz();
        const buf = await buildInflowReportPdf({
          storeName: brand.storeName,
          periodLabel: `${date_from} s/d ${date_to}`,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows: rowsOut,
          grand,
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="inflow_${date_from}_${date_to}.pdf"`
        );
        return reply.send(buf);
      }

      // 10) JSON default
      return reply.send({
        ok: true,
        from: date_from,
        to: date_to,
        groupBy: isAdmin ? groupBy : false,
        data: rowsOut,
        grand,
      });
    }
  );
}
