// packages/api/src/routes/reportsReturns.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildReturnsReportPdf } from "../utils/pdf";

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

export default async function reportsReturnsRoutes(app: FastifyInstance) {
  app.get(
    "/reports/returns",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().min(10, "date_from wajib (YYYY-MM-DD)"),
        date_to: z.string().min(10, "date_to wajib (YYYY-MM-DD)"),
        cashierId: z.string().optional(),
        locationCode: z.string().optional(),
        q: z.string().optional(),
        detail: z.coerce.boolean().optional().default(false),
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
        locationCode,
        q,
        detail,
        export: exportFmt,
      } = parsed.data;

      const df = new Date(date_from + "T00:00:00");
      const dt = new Date(date_to + "T23:59:59.999");
      if (isNaN(df.getTime()) || isNaN(dt.getTime())) {
        return reply
          .code(400)
          .send({ ok: false, error: "date_from/date_to invalid" });
      }

      // RBAC: kasir hanya data miliknya
      const user = (req as any).user as { id: string; role: string };
      const cashierFilter =
        user.role === "kasir"
          ? { cashierId: user.id }
          : cashierId
          ? { cashierId }
          : undefined;

      const locationFilter = locationCode
        ? { location: { code: locationCode } }
        : undefined;

      // jika PDF → paksa include lines supaya selalu tampil item
      const needLines = detail || (exportFmt ?? "").toLowerCase() === "pdf";

      const include: any = {
        location: { select: { code: true, name: true } },
        sale: { select: { number: true, customerId: true } },
        cashier: { select: { id: true, username: true } },
        payments: true,
        ...(needLines
          ? {
              lines: {
                include: { product: { select: { sku: true, name: true } } },
              },
            }
          : {}),
      };

      const rows = await prisma.saleReturn.findMany({
        where: {
          createdAt: { gte: df, lte: dt },
          ...(cashierFilter ?? {}),
          ...(locationFilter ?? {}),
        },
        orderBy: { createdAt: "desc" },
        include,
      });

      // ---- Customer lookup
      const customerIds = Array.from(
        new Set(
          rows
            .map((r) => r.sale?.customerId)
            .filter((x): x is string => typeof x === "string" && x.length > 0)
        )
      );
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

      // ---- Breakdown
      function refundBreakdown(payments: any[]) {
        const CASH = (payments || [])
          .filter((p) => p.kind === "REFUND" && p.method === "CASH")
          .reduce((s, p) => s + Number(p.amount), 0);
        const NON_CASH = (payments || [])
          .filter((p) => p.kind === "REFUND" && p.method === "NON_CASH")
          .reduce((s, p) => s + Number(p.amount), 0);
        const TOTAL = CASH + NON_CASH;
        return { CASH, NON_CASH, TOTAL };
      }

      // ---- filter q
      let filtered = rows;
      if (q) {
        const qq = q.toLowerCase();
        filtered = rows.filter((r) => {
          const cust =
            r.sale?.customerId && custMap.get(r.sale.customerId)
              ? custMap.get(r.sale.customerId)!
              : undefined;
          const conds: boolean[] = [
            r.number?.toLowerCase().includes(qq) ?? false,
            r.sale?.number?.toLowerCase().includes(qq) ?? false,
            r.location?.code?.toLowerCase().includes(qq) ?? false,
            r.location?.name?.toLowerCase().includes(qq) ?? false,
            (r as any).reason?.toLowerCase?.().includes(qq) ?? false,
            r.cashier?.username?.toLowerCase().includes(qq) ?? false,
            cust?.name?.toLowerCase().includes(qq) ?? false,
          ];
          if (needLines && r.lines) {
            conds.push(
              r.lines.some(
                (l) =>
                  l.product?.sku?.toLowerCase().includes(qq) ||
                  l.product?.name?.toLowerCase().includes(qq) ||
                  l.uom.toLowerCase().includes(qq)
              )
            );
          }
          return conds.some(Boolean);
        });
      }

      // ===========================
      //        EXPORT = CSV
      // ===========================
      if ((exportFmt ?? "").toLowerCase() === "csv") {
        if (!detail) {
          const headers = [
            "number",
            "saleNumber",
            "customerName",
            "memberCode",
            "cashier",
            "locationCode",
            "locationName",
            "subtotal",
            "refundCash",
            "refundNonCash",
            "refundTotal",
            "reason",
            "createdAt",
          ];
          const rowsCsv = filtered.map((r) => {
            const cust =
              r.sale?.customerId && custMap.get(r.sale.customerId)
                ? custMap.get(r.sale.customerId)!
                : undefined;
            const rb = refundBreakdown(r.payments || []);
            return {
              number: r.number,
              saleNumber: r.sale?.number ?? "",
              customerName: cust?.name ?? "",
              memberCode: cust?.memberCode ?? "",
              cashier: r.cashier?.username ?? "",
              locationCode: r.location?.code ?? "",
              locationName: r.location?.name ?? "",
              subtotal: String(r.subtotal),
              refundCash: String(rb.CASH),
              refundNonCash: String(rb.NON_CASH),
              refundTotal: String(rb.TOTAL),
              reason: (r as any).reason ?? "",
              createdAt: r.createdAt.toISOString(),
            };
          });
          const csv = toCsv(headers, rowsCsv);
          return sendCsv(reply, `returns_${date_from}_${date_to}.csv`, csv);
        } else {
          const headers = [
            "number",
            "saleNumber",
            "customerName",
            "memberCode",
            "cashier",
            "locationCode",
            "locationName",
            "sku",
            "name",
            "uom",
            "qty",
            "price",
            "subtotalLine",
            "refundCash",
            "refundNonCash",
            "refundTotal",
            "reason",
            "createdAt",
          ];
          const rowsCsv = filtered.flatMap((r) => {
            const cust =
              r.sale?.customerId && custMap.get(r.sale.customerId)
                ? custMap.get(r.sale.customerId)!
                : undefined;
            const rb = refundBreakdown(r.payments || []);
            return (r.lines ?? []).map((l) => ({
              number: r.number,
              saleNumber: r.sale?.number ?? "",
              customerName: cust?.name ?? "",
              memberCode: cust?.memberCode ?? "",
              cashier: r.cashier?.username ?? "",
              locationCode: r.location?.code ?? "",
              locationName: r.location?.name ?? "",
              sku: l.product?.sku ?? "",
              name: l.product?.name ?? "",
              uom: l.uom,
              qty: String(l.qty),
              price: String(l.price),
              subtotalLine: String(l.subtotal),
              refundCash: String(rb.CASH),
              refundNonCash: String(rb.NON_CASH),
              refundTotal: String(rb.TOTAL),
              reason: (r as any).reason ?? "",
              createdAt: r.createdAt.toISOString(),
            }));
          });
          const csv = toCsv(headers, rowsCsv);
          return sendCsv(
            reply,
            `returns_detail_${date_from}_${date_to}.csv`,
            csv
          );
        }
      }

      // ===========================
      //        EXPORT = PDF
      // ===========================
      if ((exportFmt ?? "").toLowerCase() === "pdf") {
        const brand = await loadStoreBrand();
        const sections = filtered.map((r) => {
          const cust =
            r.sale?.customerId && custMap.get(r.sale.customerId)
              ? custMap.get(r.sale.customerId)!
              : undefined;
          const rb = refundBreakdown(r.payments || []);
          const items =
            (r.lines ?? []).map((l: any) => ({
              sku: l.product?.sku ?? null,
              name: l.product?.name ?? "",
              uom: l.uom,
              qty: Number(l.qty),
              price: Number(l.price),
              subtotal: Number(l.subtotal),
            })) ?? [];
          const refundLines = (r.payments || [])
            .filter((p) => p.kind === "REFUND")
            .map((p) => ({
              method: p.method as "CASH" | "NON_CASH",
              amount: Number(p.amount),
              ref: p.ref ?? null,
            }));

          return {
            number: r.number,
            createdAt: r.createdAt,
            saleNumber: r.sale?.number ?? null,
            customerName: cust?.name ?? null,
            memberCode: cust?.memberCode ?? null,
            cashierUsername: r.cashier?.username ?? null,
            locationCode: r.location?.code ?? null,
            locationName: r.location?.name ?? null,
            reason: (r as any).reason ?? null,
            items,
            refunds: refundLines,
            subtotal: Number(r.subtotal),
            refundCash: rb.CASH,
            refundNonCash: rb.NON_CASH,
            refundTotal: rb.TOTAL,
          };
        });

        const buf = await buildReturnsReportPdf({
          storeName: brand.storeName,
          periodLabel: `${date_from} s/d ${date_to}`,
          storeLogoBuffer: brand.storeLogoBuffer,
          storeFooterNote: brand.storeFooterNote,
          rows: sections,
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="returns_${date_from}_${date_to}.pdf"`
        );
        return reply.send(buf);
      }

      // ===========================
      //        JSON DEFAULT
      // ===========================
      return reply.send({
        ok: true,
        data: filtered.map((r) => {
          const cust =
            r.sale?.customerId && custMap.get(r.sale.customerId)
              ? custMap.get(r.sale.customerId)!
              : undefined;
          const rb = refundBreakdown(r.payments || []);
          return {
            id: r.id,
            number: r.number,
            saleNumber: r.sale?.number ?? "",
            customer: cust
              ? { id: cust.id, name: cust.name, memberCode: cust.memberCode }
              : null,
            cashier: r.cashier
              ? { id: r.cashier.id, username: r.cashier.username }
              : null,
            location: r.location,
            subtotal: Number(r.subtotal),
            refunds: rb,
            reason: (r as any).reason ?? null,
            createdAt: r.createdAt,
            lines:
              (r.lines ?? []).map((l: any) => ({
                productId: l.productId,
                sku: l.product?.sku,
                name: l.product?.name,
                uom: l.uom,
                qty: Number(l.qty),
                price: Number(l.price),
                subtotal: Number(l.subtotal),
              })) ?? [],
          };
        }),
      });
    }
  );
}
