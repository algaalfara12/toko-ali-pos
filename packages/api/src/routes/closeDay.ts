// packages/api/src/routes/closeDay.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { toCsv, sendCsv } from "../utils/csv";
import { buildClosingPdf } from "../utils/pdf";

// helper: range harian lokal dari YYYY-MM-DD (atau today)
function localDayRange(dateStr?: string) {
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
  const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(start.getDate()).padStart(2, "0")}`;
  return { start, end, label };
}

// helper format local "YYYY-MM-DD" dari Date (tanpa toISOString agar tidak bergeser UTC)
function toLocalDateLabel(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function closeDayRoutes(app: FastifyInstance) {
  // POST /pos/close-day
  // Body: { date?: YYYY-MM-DD, cashierId?: uuid, note?: string }
  // - kasir: cashierId harus = token.id (force by server)
  // - admin: cashierId wajib diisi
  // - idempotent per (cashierId,date)
  app.post(
    "/pos/close-day",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date: z.string().optional(),
        cashierId: z.string().uuid().optional(),
        note: z.string().optional(),
      });
      const p = Q.safeParse(req.body);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }

      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      const role = user.role;

      // tentukan cashierId
      let cashierId: string | null = null;
      if (role === "kasir") {
        cashierId = user.id;
      } else {
        // admin
        if (!p.data.cashierId) {
          return reply
            .code(400)
            .send({ ok: false, error: "cashierId wajib untuk admin" });
        }
        cashierId = p.data.cashierId;
      }

      // obtain cashier for username snapshot
      const cashier = await prisma.user.findUnique({
        where: { id: cashierId },
      });
      if (!cashier) {
        return reply
          .code(400)
          .send({ ok: false, error: "Cashier tidak ditemukan" });
      }

      // local date range
      const { start, end, label } = localDayRange(p.data.date);

      // Ambil sales milik kasir pd tanggal itu
      const sales = await prisma.sale.findMany({
        where: { createdAt: { gte: start, lte: end }, cashierId },
        include: { lines: true },
      });
      const saleIds = sales.map((s) => s.id);

      // Payment SALE
      const salePays = saleIds.length
        ? await prisma.payment.findMany({
            where: { kind: "SALE", saleId: { in: saleIds } },
            select: { saleId: true, method: true, amount: true },
          })
        : [];

      const bySaleId: Record<string, { CASH: number; NON_CASH: number }> = {};
      for (const sid of saleIds) bySaleId[sid] = { CASH: 0, NON_CASH: 0 };
      for (const py of salePays) {
        const sid = py.saleId!;
        const method = py.method as "CASH" | "NON_CASH";
        const amt = Number(py.amount);
        if (!bySaleId[sid]) bySaleId[sid] = { CASH: 0, NON_CASH: 0 };
        bySaleId[sid][method] += amt;
      }

      const salesCash = Object.values(bySaleId).reduce((t, x) => t + x.CASH, 0);
      const salesNonCash = Object.values(bySaleId).reduce(
        (t, x) => t + x.NON_CASH,
        0
      );
      const salesAll = salesCash + salesNonCash;

      // item count
      const items = sales.reduce(
        (sum, s) =>
          sum + (s.lines?.reduce((a, l) => a + Number(l.qty ?? 0), 0) ?? 0),
        0
      );

      // Ambil returns milik kasir pd tanggal itu
      const returns = await prisma.saleReturn.findMany({
        where: { createdAt: { gte: start, lte: end }, cashierId },
        select: { id: true },
      });
      const returnIds = returns.map((r) => r.id);

      // Payment REFUND
      const refundPays = returnIds.length
        ? await prisma.payment.findMany({
            where: { kind: "REFUND", saleReturnId: { in: returnIds } },
            select: { method: true, amount: true },
          })
        : [];

      let refundCash = 0,
        refundNonCash = 0;
      for (const py of refundPays) {
        const amt = Number(py.amount);
        if (py.method === "CASH") refundCash += amt;
        else refundNonCash += amt;
      }
      const refundAll = refundCash + refundNonCash;

      // Nett
      const nettCash = salesCash - refundCash;
      const nettNonCash = salesNonCash - refundNonCash;
      const nettAll = salesAll - refundAll;

      // idempotency by (cashierId, date)
      const dayDate = new Date(start);
      const exist = await prisma.cashierClosing.findFirst({
        where: { cashierId, date: dayDate },
      });
      if (exist) {
        return reply.code(409).send({
          ok: false,
          error: `Sudah ada closing untuk kasir ini pada ${label}`,
          closingId: exist.id,
        });
      }

      const created = await prisma.cashierClosing.create({
        data: {
          date: dayDate,
          cashierId,
          cashierUsername: cashier.username,
          salesCash,
          salesNonCash,
          salesAll,
          items,
          refundCash,
          refundNonCash,
          refundAll,
          nettCash,
          nettNonCash,
          nettAll,
          note: p.data.note ?? null,
        },
      });

      return reply.send({ ok: true, data: created, label });
    }
  );

  // GET /pos/close-day (list + csv)
  app.get(
    "/pos/close-day",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        cashierId: z.string().uuid().optional(),
        page: z.coerce.number().int().positive().optional().default(1),
        pageSize: z.coerce
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .default(50),
        export: z.string().optional(),
      });
      const p = Q.safeParse(req.query);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }
      const {
        date_from,
        date_to,
        cashierId,
        page,
        pageSize,
        export: exportFmt,
      } = p.data;

      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      const role = user.role;
      let cashierFilter: any = {};
      if (role === "kasir") {
        cashierFilter = { cashierId: user.id };
      } else if (cashierId) {
        cashierFilter = { cashierId };
      }

      let df: Date | undefined, dt: Date | undefined;
      if (date_from) df = new Date(date_from + "T00:00:00");
      if (date_to) dt = new Date(date_to + "T23:59:59.999");

      const where: any = {
        ...(Object.keys(cashierFilter).length ? cashierFilter : {}),
        ...(df && dt
          ? { date: { gte: df, lte: dt } }
          : df
          ? { date: { gte: df } }
          : dt
          ? { date: { lte: dt } }
          : {}),
      };

      const skip = (page - 1) * pageSize;

      const [total, rows] = await Promise.all([
        prisma.cashierClosing.count({ where }),
        prisma.cashierClosing.findMany({
          where,
          orderBy: [{ date: "desc" }, { cashierUsername: "asc" }],
          skip,
          take: pageSize,
        }),
      ]);

      if ((exportFmt ?? "").toLowerCase() === "csv") {
        const headers = [
          "date",
          "cashierId",
          "cashierUsername",
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
          "note",
          "createdAt",
        ];
        const csvRows = rows.map((r) => ({
          // gunakan tanggal lokal untuk konsistensi
          date: toLocalDateLabel(r.date),
          cashierId: r.cashierId,
          cashierUsername: r.cashierUsername,
          sales_cash: String(r.salesCash),
          sales_non_cash: String(r.salesNonCash),
          sales_all: String(r.salesAll),
          items: String(r.items),
          refund_cash: String(r.refundCash),
          refund_non_cash: String(r.refundNonCash),
          refund_all: String(r.refundAll),
          nett_cash: String(r.nettCash),
          nett_non_cash: String(r.nettNonCash),
          nett_all: String(r.nettAll),
          note: r.note ?? "",
          createdAt: r.createdAt.toISOString(),
        }));
        const csv = toCsv(headers, csvRows);
        return sendCsv(
          reply,
          `cashier_closing_${date_from ?? ""}_${date_to ?? ""}.csv`,
          csv
        );
      }

      // tambahkan label tanggal lokal untuk tampilan JSON
      const data = rows.map((r) => ({
        ...r,
        dateLabel: toLocalDateLabel(r.date),
      }));

      return reply.send({ ok: true, page, pageSize, total, data });
    }
  );

  // GET /pos/close-day/:id  → JSON / PDF
  app.get(
    "/pos/close-day/:id",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({ export: z.string().optional() });
      const p = Q.safeParse(req.query);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }
      const exportFmt = (p.data.export ?? "").toLowerCase();

      const { id } = req.params as any;
      const row = await prisma.cashierClosing.findUnique({
        where: { id: String(id) },
      });
      if (!row) {
        return reply.code(404).send({ ok: false, error: "Not found" });
      }

      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      if (user.role === "kasir" && row.cashierId !== user.id) {
        return reply.code(403).send({ ok: false, error: "Forbidden" });
      }

      const detail = {
        ...row,
        dateLabel: toLocalDateLabel(row.date),
      };

      if (exportFmt === "pdf") {
        // Ambil store profile untuk brand dinamis (logo + footer)
        const sp = await prisma.storeProfile.findFirst();
        const storeName = sp?.name ?? "TOKO ALI POS";
        const footerNote = sp?.footerNote ?? undefined;
        const logoUrl = sp?.logoUrl ?? undefined;

        const buf = await buildClosingPdf({
          storeName,
          dateLabel: detail.dateLabel,
          cashierId: detail.cashierId,
          cashierUsername: detail.cashierUsername,
          createdAt: detail.createdAt,
          note: detail.note ?? null,
          summary: {
            salesCash: Number(detail.salesCash),
            salesNonCash: Number(detail.salesNonCash),
            salesAll: Number(detail.salesAll),
            items: Number(detail.items),
            refundCash: Number(detail.refundCash),
            refundNonCash: Number(detail.refundNonCash),
            refundAll: Number(detail.refundAll),
            nettCash: Number(detail.nettCash),
            nettNonCash: Number(detail.nettNonCash),
            nettAll: Number(detail.nettAll),
          },
          footerNote,
          logoUrl,
        });
        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="closing_${detail.dateLabel}_${detail.cashierUsername}.pdf"`
        );
        return reply.send(buf);
      }

      return reply.send({ ok: true, data: detail });
    }
  );

  // DELETE /pos/close-day/:id (admin only)
  app.delete(
    "/pos/close-day/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const { id } = req.params as any;
      const row = await prisma.cashierClosing.findUnique({
        where: { id: String(id) },
      });
      if (!row) return reply.code(404).send({ ok: false, error: "Not found" });

      await prisma.cashierClosing.delete({ where: { id: row.id } });
      return reply.send({ ok: true, deletedId: row.id });
    }
  );
}
