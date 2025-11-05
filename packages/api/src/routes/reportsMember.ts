import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildCustomersListPdf, buildTopCustomersPdf } from "../utils/pdf";

/** Helper: load StoreProfile + logo + timezone */
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
    } catch {
      // abaikan error logo
    }
  }
  return { ...brand, storeLogoBuffer };
}

/** Helper: parse YYYY-MM-DD → local Date range 00:00–23:59:59.999 */
function toRange(date_from?: string, date_to?: string) {
  if (!date_from || !date_to)
    return {
      df: undefined as Date | undefined,
      dt: undefined as Date | undefined,
    };
  const d1 = new Date(date_from + "T00:00:00");
  const d2 = new Date(date_to + "T23:59:59.999");
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
    return { df: undefined, dt: undefined };
  }
  return { df: d1, dt: d2 };
}

export default async function reportsMembersRoutes(app: FastifyInstance) {
  // ===================================================================
  // A) LIST MASTER CUSTOMERS (PDF/CSV), opsional metrik nett pada range
  //    GET /reports/customers?date_from=&date_to=&q=&export=pdf|csv
  //    RBAC: admin only
  // ===================================================================
  app.get(
    "/reports/customers",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        q: z.string().optional(),
        export: z.string().optional(), // 'pdf' | 'csv'
      });
      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      const { date_from, date_to, q, export: exportFmtRaw } = p.data;
      const exportFmt = (exportFmtRaw ?? "").toLowerCase();

      // Ambil daftar customers (tanpa createdAt), urutkan by name asc agar stabil
      let customers = await prisma.customer.findMany({
        orderBy: { name: "asc" },
        select: { id: true, memberCode: true, name: true, phone: true },
      });

      if (q) {
        const qq = q.toLowerCase();
        customers = customers.filter(
          (c) =>
            (c.memberCode ?? "").toLowerCase().includes(qq) ||
            (c.name ?? "").toLowerCase().includes(qq) ||
            (c.phone ?? "").toLowerCase().includes(qq)
        );
      }

      // Jika ada range → hitung nett metrics per customer
      let df: Date | undefined, dt: Date | undefined;
      ({ df, dt } = toRange(date_from, date_to));

      let agg: Record<
        string,
        {
          txSale: number;
          txReturn: number;
          txNett: number;
          qtySale: number;
          qtyReturn: number;
          qtyNett: number;
          sales: number;
          refunds: number;
          nett: number;
        }
      > = {};

      if (df && dt) {
        const custIds = customers.map((c) => c.id);
        if (custIds.length) {
          // SALES in range
          const sales = await prisma.sale.findMany({
            where: {
              createdAt: { gte: df, lte: dt },
              customerId: { in: custIds },
            },
            select: { id: true, customerId: true },
          });
          const saleIds = sales.map((s) => s.id);

          // Payment SALE
          const pays = saleIds.length
            ? await prisma.payment.findMany({
                where: { saleId: { in: saleIds }, kind: "SALE" },
                select: { saleId: true, amount: true },
              })
            : [];

          // Sale lines qty
          const lines = saleIds.length
            ? await prisma.saleLine.findMany({
                where: { saleId: { in: saleIds } },
                select: { saleId: true, qty: true },
              })
            : [];

          // Map saleId → customerId
          const saleToCust = new Map<string, string>();
          for (const s of sales) saleToCust.set(s.id, s.customerId!);

          // Init agg
          agg = {};
          for (const s of sales) {
            const cid = s.customerId!;
            if (!agg[cid]) {
              agg[cid] = {
                txSale: 0,
                txReturn: 0,
                txNett: 0,
                qtySale: 0,
                qtyReturn: 0,
                qtyNett: 0,
                sales: 0,
                refunds: 0,
                nett: 0,
              };
            }
            agg[cid].txSale += 1;
          }
          for (const l of lines) {
            const cid = saleToCust.get(l.saleId!);
            if (!cid) continue;
            if (!agg[cid]) {
              agg[cid] = {
                txSale: 0,
                txReturn: 0,
                txNett: 0,
                qtySale: 0,
                qtyReturn: 0,
                qtyNett: 0,
                sales: 0,
                refunds: 0,
                nett: 0,
              };
            }
            agg[cid].qtySale += Number(l.qty);
          }
          for (const pmt of pays) {
            const cid = saleToCust.get(pmt.saleId!);
            if (!cid) continue;
            if (!agg[cid]) {
              agg[cid] = {
                txSale: 0,
                txReturn: 0,
                txNett: 0,
                qtySale: 0,
                qtyReturn: 0,
                qtyNett: 0,
                sales: 0,
                refunds: 0,
                nett: 0,
              };
            }
            agg[cid].sales += Number(pmt.amount);
          }

          // RETURNS in range (by return date)
          const returns = await prisma.saleReturn.findMany({
            where: {
              createdAt: { gte: df, lte: dt },
              sale: { customerId: { in: custIds } },
            },
            select: {
              id: true,
              sale: { select: { customerId: true } },
              lines: { select: { qty: true } },
            },
          });

          for (const r of returns) {
            const cid = r.sale?.customerId;
            if (!cid) continue;
            if (!agg[cid]) {
              agg[cid] = {
                txSale: 0,
                txReturn: 0,
                txNett: 0,
                qtySale: 0,
                qtyReturn: 0,
                qtyNett: 0,
                sales: 0,
                refunds: 0,
                nett: 0,
              };
            }
            agg[cid].txReturn += 1;
            const qtyR = (r.lines || []).reduce(
              (t, x) => t + Number(x.qty ?? 0),
              0
            );
            agg[cid].qtyReturn += qtyR;
          }

          // Payment REFUND
          const retIds = returns.map((r) => r.id);
          const refPays = retIds.length
            ? await prisma.payment.findMany({
                where: { saleReturnId: { in: retIds }, kind: "REFUND" },
                select: { saleReturnId: true, amount: true },
              })
            : [];
          // Map return → cust
          const retToCust = new Map<string, string>();
          for (const r of returns) {
            if (r.sale?.customerId) retToCust.set(r.id, r.sale.customerId);
          }
          for (const rp of refPays) {
            const cid = retToCust.get(rp.saleReturnId!);
            if (!cid) continue;
            if (!agg[cid]) {
              agg[cid] = {
                txSale: 0,
                txReturn: 0,
                txNett: 0,
                qtySale: 0,
                qtyReturn: 0,
                qtyNett: 0,
                sales: 0,
                refunds: 0,
                nett: 0,
              };
            }
            agg[cid].refunds += Number(rp.amount);
          }

          // Finalize nett fields
          for (const cid of Object.keys(agg)) {
            agg[cid].txNett = agg[cid].txSale - agg[cid].txReturn;
            agg[cid].qtyNett = agg[cid].qtySale - agg[cid].qtyReturn;
            agg[cid].nett = agg[cid].sales - agg[cid].refunds;
          }
        }
      }

      // ==== EXPORTS ====
      if (exportFmt === "csv") {
        const headers =
          df && dt
            ? [
                "memberCode",
                "name",
                "phone",
                "txSale",
                "txReturn",
                "txNett",
                "qtySale",
                "qtyReturn",
                "qtyNett",
                "sales",
                "refunds",
                "nett",
              ]
            : ["memberCode", "name", "phone"];
        const rows = customers.map((c) => {
          if (df && dt) {
            const a = agg[c.id] ?? {
              txSale: 0,
              txReturn: 0,
              txNett: 0,
              qtySale: 0,
              qtyReturn: 0,
              qtyNett: 0,
              sales: 0,
              refunds: 0,
              nett: 0,
            };
            return {
              memberCode: c.memberCode ?? "",
              name: c.name ?? "",
              phone: c.phone ?? "",
              txSale: String(a.txSale),
              txReturn: String(a.txReturn),
              txNett: String(a.txNett),
              qtySale: String(a.qtySale),
              qtyReturn: String(a.qtyReturn),
              qtyNett: String(a.qtyNett),
              sales: String(a.sales),
              refunds: String(a.refunds),
              nett: String(a.nett),
            };
          }
          return {
            memberCode: c.memberCode ?? "",
            name: c.name ?? "",
            phone: c.phone ?? "",
          };
        });
        const csv = toCsv(headers, rows);
        const fname =
          df && dt
            ? `customers_${date_from}_${date_to}.csv`
            : `customers_all.csv`;
        return sendCsv(reply, fname, csv);
      }

      if (exportFmt === "pdf") {
        const brand = await loadStoreBrandWithTz();
        const rows = customers.map((c) => {
          const a = agg[c.id];
          return {
            memberCode: c.memberCode ?? "",
            name: c.name ?? "",
            phone: c.phone ?? "",
            metrics: a
              ? {
                  txSale: a.txSale,
                  txReturn: a.txReturn,
                  txNett: a.txNett,
                  qtySale: a.qtySale,
                  qtyReturn: a.qtyReturn,
                  qtyNett: a.qtyNett,
                  sales: a.sales,
                  refunds: a.refunds,
                  nett: a.nett,
                }
              : undefined,
          };
        });

        const buf = await buildCustomersListPdf({
          storeName: brand.storeName,
          periodLabel: df && dt ? `${date_from} s/d ${date_to}` : `SEMUA DATA`,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows,
          showMetrics: !!(df && dt),
        });
        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="customers_${
            df && dt ? `${date_from}_${date_to}` : "all"
          }.pdf"`
        );
        return reply.send(buf);
      }

      // JSON default
      return reply.send({
        ok: true,
        filter: {
          date_from: date_from ?? null,
          date_to: date_to ?? null,
          q: q ?? null,
        },
        count: customers.length,
        ...(df && dt ? { metrics: agg } : {}),
        data: customers,
      });
    }
  );

  // ===================================================================
  // B) TOP CUSTOMERS (nett revenue) — PDF/CSV
  //    GET /reports/customers/top?date_from=&date_to=&limit=20&export=pdf|csv
  //    *date_from,date_to opsional* → all time jika kosong.
  //    RBAC: admin only
  // ===================================================================
  app.get(
    "/reports/customers/top",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(20),
        export: z.string().optional(), // 'pdf' | 'csv'
      });
      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const { date_from, date_to, limit, export: exportFmtRaw } = p.data;
      const exportFmt = (exportFmtRaw ?? "").toLowerCase();
      const { df, dt } = toRange(date_from, date_to); // undefined → all time

      // SALES (all time atau range)
      const saleWhere: any = {};
      if (df && dt) saleWhere.createdAt = { gte: df, lte: dt };
      saleWhere.NOT = { customerId: null };

      const sales = await prisma.sale.findMany({
        where: saleWhere,
        select: { id: true, customerId: true },
      });
      const saleIds = sales.map((s) => s.id);

      // Payment SALE
      const pays = saleIds.length
        ? await prisma.payment.findMany({
            where: { saleId: { in: saleIds }, kind: "SALE" },
            select: { saleId: true, amount: true },
          })
        : [];

      // Qty sale
      const lines = saleIds.length
        ? await prisma.saleLine.findMany({
            where: { saleId: { in: saleIds } },
            select: { saleId: true, qty: true },
          })
        : [];

      // RETURNS by return date (all time atau range)
      const retWhere: any = {};
      if (df && dt) retWhere.createdAt = { gte: df, lte: dt };
      retWhere.NOT = { sale: { customerId: null } };

      const returns = await prisma.saleReturn.findMany({
        where: retWhere,
        select: {
          id: true,
          sale: { select: { customerId: true } },
          lines: { select: { qty: true } },
        },
      });
      const retIds = returns.map((r) => r.id);

      const retPays = retIds.length
        ? await prisma.payment.findMany({
            where: { saleReturnId: { in: retIds }, kind: "REFUND" },
            select: { saleReturnId: true, amount: true },
          })
        : [];

      // Aggregasi per customerId
      type A = {
        txSale: number;
        qtySale: number;
        qtyReturn: number;
        qtyNett: number;
        sales: number;
        refunds: number;
        nett: number;
      };
      const agg = new Map<string, A>();

      const saleToCust = new Map<string, string>();
      for (const s of sales) saleToCust.set(s.id, s.customerId!);

      for (const s of sales) {
        const cid = s.customerId!;
        if (!agg.has(cid))
          agg.set(cid, {
            txSale: 0,
            qtySale: 0,
            qtyReturn: 0,
            qtyNett: 0,
            sales: 0,
            refunds: 0,
            nett: 0,
          });
        agg.get(cid)!.txSale += 1;
      }
      for (const l of lines) {
        const cid = saleToCust.get(l.saleId!);
        if (!cid) continue;
        if (!agg.has(cid))
          agg.set(cid, {
            txSale: 0,
            qtySale: 0,
            qtyReturn: 0,
            qtyNett: 0,
            sales: 0,
            refunds: 0,
            nett: 0,
          });
        agg.get(cid)!.qtySale += Number(l.qty);
      }
      for (const pmt of pays) {
        const cid = saleToCust.get(pmt.saleId!);
        if (!cid) continue;
        if (!agg.has(cid))
          agg.set(cid, {
            txSale: 0,
            qtySale: 0,
            qtyReturn: 0,
            qtyNett: 0,
            sales: 0,
            refunds: 0,
            nett: 0,
          });
        agg.get(cid)!.sales += Number(pmt.amount);
      }

      // Map return → customer + qtyReturn
      const retToCust = new Map<string, string>();
      for (const r of returns) {
        if (r.sale?.customerId) {
          retToCust.set(r.id, r.sale.customerId);
          const qRet = (r.lines || []).reduce(
            (t, x) => t + Number(x.qty ?? 0),
            0
          );
          const cid = r.sale.customerId;
          if (!agg.has(cid))
            agg.set(cid, {
              txSale: 0,
              qtySale: 0,
              qtyReturn: 0,
              qtyNett: 0,
              sales: 0,
              refunds: 0,
              nett: 0,
            });
          agg.get(cid)!.qtyReturn += qRet;
        }
      }
      for (const rp of retPays) {
        const cid = retToCust.get(rp.saleReturnId!);
        if (!cid) continue;
        if (!agg.has(cid))
          agg.set(cid, {
            txSale: 0,
            qtySale: 0,
            qtyReturn: 0,
            qtyNett: 0,
            sales: 0,
            refunds: 0,
            nett: 0,
          });
        agg.get(cid)!.refunds += Number(rp.amount);
      }
      for (const a of agg.values()) {
        a.qtyNett = a.qtySale - a.qtyReturn;
        a.nett = a.sales - a.refunds;
      }

      // Ambil info customer
      const custIds = Array.from(agg.keys());
      const custs = await prisma.customer.findMany({
        where: { id: { in: custIds } },
        select: { id: true, memberCode: true, name: true, phone: true },
      });
      const custMap = new Map<
        string,
        { memberCode: string | null; name: string | null; phone: string | null }
      >();
      for (const c of custs)
        custMap.set(c.id, {
          memberCode: c.memberCode,
          name: c.name,
          phone: c.phone,
        });

      let rows = Array.from(agg.entries()).map(([cid, a]) => ({
        customerId: cid,
        memberCode: custMap.get(cid)?.memberCode ?? "",
        name: custMap.get(cid)?.name ?? "",
        phone: custMap.get(cid)?.phone ?? "",
        txSale: a.txSale,
        qtyNett: a.qtyNett,
        sales: a.sales,
        refunds: a.refunds,
        nett: a.nett,
      }));

      rows.sort((x, y) => y.nett - x.nett);
      rows = rows.slice(0, limit);

      // EXPORTS
      const label = df && dt ? `${date_from} s/d ${date_to}` : "SEMUA DATA";
      if (exportFmt === "csv") {
        const headers = [
          "memberCode",
          "name",
          "phone",
          "txSale",
          "qtyNett",
          "sales",
          "refunds",
          "nett",
        ];
        const rowsCsv = rows.map((r) => ({
          memberCode: r.memberCode,
          name: r.name,
          phone: r.phone,
          txSale: String(r.txSale),
          qtyNett: String(r.qtyNett),
          sales: String(r.sales),
          refunds: String(r.refunds),
          nett: String(r.nett),
        }));
        const csv = toCsv(headers, rowsCsv);
        return sendCsv(
          reply,
          `top_customers_${label.replace(/\s+/g, "")}.csv`,
          csv
        );
      }

      if (exportFmt === "pdf") {
        const brand = await loadStoreBrandWithTz();
        const buf = await buildTopCustomersPdf({
          storeName: brand.storeName,
          periodLabel: label,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows: rows.map((r, idx) => ({
            rank: idx + 1,
            memberCode: r.memberCode,
            name: r.name,
            phone: r.phone,
            txSale: r.txSale,
            qtyNett: r.qtyNett,
            sales: r.sales,
            refunds: r.refunds,
            nett: r.nett,
          })),
        });
        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="top_customers_${label.replace(
            /\s+/g,
            ""
          )}.pdf"`
        );
        return reply.send(buf);
      }

      // JSON default
      return reply.send({
        ok: true,
        period: label,
        limit,
        count: rows.length,
        data: rows,
      });
    }
  );
}
