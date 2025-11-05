// packages/api/src/routes/salesReceipt.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { buildSaleReceiptPdf } from "../utils/pdf";

export default async function salesReceiptRoutes(app: FastifyInstance) {
  app.get(
    "/sales/:id/receipt",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        export: z.string().optional(),
        paper: z.enum(["58", "80", "A6"]).optional(),
      });
      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      const exportFmt = (p.data.export ?? "").toLowerCase();
      const paper = p.data.paper ?? "A6";

      const { id } = req.params as any;
      const sale = await prisma.sale.findUnique({
        where: { id: String(id) },
        include: {
          cashier: { select: { username: true, id: true } },
          customer: { select: { name: true, memberCode: true } },
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
          payments: true,
        },
      });
      if (!sale)
        return reply
          .code(404)
          .send({ ok: false, error: "Sale tidak ditemukan" });

      // RBAC: kasir hanya miliknya
      const user = (req as any).user as {
        id: string;
        role: string;
        username: string;
      };
      if (user.role === "kasir" && sale.cashierId !== user.id) {
        return reply.code(403).send({ ok: false, error: "Forbidden" });
      }

      // Ambil store profile (untuk branding dinamis)
      const sp = await prisma.storeProfile.findFirst();
      const storeName = sp?.name ?? "TOKO ALI POS";
      const storeAddress = sp?.address ?? undefined;
      const storePhone = sp?.phone ?? undefined;
      const footerNote = sp?.footerNote ?? undefined;
      const logoUrl = sp?.logoUrl ?? undefined;

      // siapkan data untuk PDF
      const items = (sale.lines ?? []).map((l) => ({
        sku: l.product?.sku ?? null,
        name: l.product?.name ?? "",
        uom: l.uom,
        qty: Number(l.qty),
        price: Number(l.price),
        discount: Number(l.discount ?? 0),
        subtotal: Number(l.subtotal),
      }));

      const paysAll = (sale.payments ?? []).filter((p) => p.kind === "SALE");
      const totalPaid = paysAll.reduce((s, p) => s + Number(p.amount), 0);
      const pays = paysAll.map((p) => ({
        method: p.method as "CASH" | "NON_CASH",
        amount: Number(p.amount),
        ref: p.ref ?? null,
      }));

      const input = {
        storeName,
        storeAddress,
        storePhone,
        footerNote,
        logoUrl,

        saleNumber: sale.number,
        dateTime: sale.createdAt,
        cashierUsername: sale.cashier?.username ?? "-",
        customerName: sale.customer?.name ?? null,
        customerCode: sale.customer?.memberCode ?? null,

        items,
        totals: {
          subtotal: Number(sale.subtotal),
          discountTotal: Number(sale.discount ?? 0),
          tax: Number(sale.tax ?? 0),
          total: Number(sale.total),
          paid: totalPaid,
          change: Number(sale.change ?? 0),
        },
        payments: pays,
      } as const;

      if (exportFmt === "pdf") {
        const buf = await buildSaleReceiptPdf({
          storeName,
          storeAddress,
          storePhone,
          storeFooterNote: footerNote,
          storeLogoBuffer: await (async () => {
            if (!logoUrl) return undefined;
            try {
              const r = await fetch(logoUrl);
              if (r.ok) return Buffer.from(await r.arrayBuffer());
            } catch {}
            return undefined;
          })(),

          saleNumber: sale.number,
          dateTime: sale.createdAt,
          cashierUsername: sale.cashier?.username ?? "-",
          customerName: sale.customer?.name ?? null,
          customerCode: sale.customer?.memberCode ?? null,

          items,
          totals: {
            subtotal: Number(sale.subtotal),
            discountTotal: Number(sale.discount ?? 0),
            tax: Number(sale.tax ?? 0),
            total: Number(sale.total),
            paid: totalPaid,
            change: Number(sale.change ?? 0),
          },
          payments: pays,

          // ← kirim paper ke builder
          paper,
        } as any);

        // JSON fallback (opsional)
        return reply.send(buf);
      }
    }
  );
}
