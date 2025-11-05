import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";

export default async function topCustomersRoutes(app: FastifyInstance) {
  app.get(
    "/reports/top-customers",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().min(10, "date_from wajib (YYYY-MM-DD)"),
        date_to: z.string().min(10, "date_to wajib (YYYY-MM-DD)"),
        limit: z.coerce
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(10),
        memberOnly: z.coerce.boolean().optional().default(true),
        export: z.string().optional(), // 'csv'
      });
      const p = Q.safeParse(req.query);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }
      const {
        date_from,
        date_to,
        limit,
        memberOnly,
        export: exportFmt,
      } = p.data;

      // parse tanggal → termasuk rentang hari penuh
      const df = new Date(date_from + "T00:00:00");
      const dt = new Date(date_to + "T23:59:59.999");
      if (isNaN(df.getTime()) || isNaN(dt.getTime())) {
        return reply
          .code(400)
          .send({ ok: false, error: "date_from/date_to invalid" });
      }

      // build where clause untuk sale
      const whereSale: any = { createdAt: { gte: df, lte: dt } };
      if (memberOnly) {
        // hanya yang punya customerId (non-null)
        whereSale.customerId = { not: null };
      }

      // Group by customerId, hitung count & sum revenue
      const groups = await prisma.sale.groupBy({
        by: ["customerId"],
        where: whereSale,
        _count: { _all: true },
        _sum: { total: true },
      });

      // sort & limit
      groups.sort((a, b) => {
        // if sum.total null → treat as 0
        const ra = Number(a._sum.total ?? 0);
        const rb = Number(b._sum.total ?? 0);
        return rb - ra;
      });
      const top = groups.slice(0, limit);

      // join dengan tabel customer untuk detail
      const data = await Promise.all(
        top.map(async (g) => {
          const cust = g.customerId
            ? await prisma.customer.findUnique({ where: { id: g.customerId } })
            : null;
          return {
            customerId: g.customerId,
            name: cust?.name ?? "(Walk-in)",
            phone: cust?.phone ?? null,
            email: cust?.email ?? null,
            memberCode: cust?.memberCode ?? null,
            txnCount: g._count._all,
            revenue: Number(g._sum.total ?? 0),
          };
        })
      );

      // Export CSV?
      if ((exportFmt ?? "").toLowerCase() === "csv") {
        const headers = [
          "customerId",
          "name",
          "phone",
          "email",
          "memberCode",
          "txnCount",
          "revenue",
        ];
        const rows = data;
        const csv = toCsv(headers, rows);
        return sendCsv(reply, `top_customers_${date_from}_${date_to}.csv`, csv);
      }

      return reply.send({
        ok: true,
        data,
        count: data.length,
        from: date_from,
        to: date_to,
      });
    }
  );
}
