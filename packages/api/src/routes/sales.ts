import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard"; // <-- TAMBAHKAN INI

function nextSaleNumber(d = new Date(), cashierCode = "K1", running = 1) {
  const pad = (n: number) => String(n).padStart(4, "0");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `TOKOAL-${yyyy}${mm}${dd}-${cashierCode}-${pad(running)}`;
}

export default async function salesRoutes(app: FastifyInstance) {
  // =======================
  // DEPRECATED: /sales/checkout
  // =======================
  app.post("/sales/checkout", async (_req, reply) => {
    return reply.code(410).send({
      ok: false,
      error:
        "Endpoint deprecated. Gunakan /pos/checkout untuk proses transaksi.",
    });
  });

  // === LIST PENJUALAN (dengan guard role) ===
  app.get(
    "/sales",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const q = req.query as any;
      const page = Math.max(1, Number(q.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
      const keyword = (q.q ? String(q.q) : "").trim();

      const where: any = keyword
        ? {
            OR: [
              { number: { contains: keyword } },
              {
                lines: {
                  some: {
                    product: {
                      OR: [
                        { sku: { contains: keyword } },
                        { name: { contains: keyword } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : undefined;

      const [total, rows] = await Promise.all([
        prisma.sale.count({ where }),
        prisma.sale.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            customer: {
              // <-- tambahkan
              select: {
                id: true,
                name: true,
                phone: true,
                email: true,
                memberCode: true,
              },
            },
            lines: {
              include: { product: { select: { sku: true, name: true } } },
            },
            payments: true,
          },
        }),
      ]);

      return reply.send({
        ok: true,
        page,
        pageSize,
        total,
        data: rows.map((s) => ({
          id: s.id,
          number: s.number,
          method: s.method,
          subtotal: Number(s.subtotal),
          discount: Number(s.discount),
          tax: Number(s.tax),
          total: Number(s.total),
          paid: Number(s.paid),
          change: Number(s.change),
          createdAt: s.createdAt,
          customer: s.customer
            ? {
                // <-- output customer ringkas
                id: s.customer.id,
                name: s.customer.name,
                phone: s.customer.phone,
                email: s.customer.email,
                memberCode: s.customer.memberCode,
              }
            : null,
          lines: s.lines.map((l) => ({
            productId: l.productId,
            sku: l.product.sku,
            name: l.product.name,
            uom: l.uom,
            qty: Number(l.qty),
            price: Number(l.price),
            discount: Number(l.discount),
            subtotal: Number(l.subtotal),
          })),
          payments: s.payments.map((p) => ({
            method: p.method,
            amount: Number(p.amount),
            ref: p.ref,
            createdAt: p.createdAt,
          })),
        })),
      });
    }
  );

  // === DETAIL PENJUALAN (dengan guard role) ===
  app.get(
    "/sales/:id",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const s = await prisma.sale.findUnique({
        where: { id },
        include: {
          customer: {
            // <-- tambahkan
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              memberCode: true,
            },
          },
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
          payments: true,
        },
      });
      if (!s)
        return reply
          .code(404)
          .send({ ok: false, error: "Sale tidak ditemukan" });

      return reply.send({
        ok: true,
        data: {
          id: s.id,
          number: s.number,
          method: s.method,
          subtotal: Number(s.subtotal),
          discount: Number(s.discount),
          tax: Number(s.tax),
          total: Number(s.total),
          paid: Number(s.paid),
          change: Number(s.change),
          createdAt: s.createdAt,
          customer: s.customer
            ? {
                // <-- output customer ringkas
                id: s.customer.id,
                name: s.customer.name,
                phone: s.customer.phone,
                email: s.customer.email,
                memberCode: s.customer.memberCode,
              }
            : null,
          lines: s.lines.map((l) => ({
            productId: l.productId,
            sku: l.product.sku,
            name: l.product.name,
            uom: l.uom,
            qty: Number(l.qty),
            price: Number(l.price),
            discount: Number(l.discount),
            subtotal: Number(l.subtotal),
          })),
          payments: s.payments.map((p) => ({
            method: p.method,
            amount: Number(p.amount),
            ref: p.ref,
            createdAt: p.createdAt,
          })),
        },
      });
    }
  );
}
