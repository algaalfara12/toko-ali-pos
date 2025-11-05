// import { FastifyInstance } from "fastify";
// import { z } from "zod";
// import { prisma } from "../prisma";
// import { requireRoles } from "../utils/roleGuard";

// export default async function reportsSalesRoutes(app: FastifyInstance) {
//   app.get(
//     "/reports/sales",
//     { preHandler: [requireRoles(app, ["admin", "kasir"])] },
//     async (req, reply) => {
//       const qschema = z.object({
//         date_from: z.string().optional(),
//         date_to: z.string().optional(),
//         cashierId: z.string().optional(),
//         method: z.enum(["CASH", "NON_CASH"]).optional(),
//         q: z.string().optional(), // search by sale.number or product sku/name
//         detail: z.coerce.boolean().optional().default(false),
//       });

//       const p = qschema.safeParse(req.query);
//       if (!p.success)
//         return reply.code(400).send({ ok: false, error: p.error.flatten() });
//       const { date_from, date_to, cashierId, method, q, detail } = p.data;

//       // RBAC: kasir hanya boleh lihat transaksi miliknya
//       // req.user diset oleh @fastify/jwt
//       const user = (req as any).user as { id: string; role: string };
//       const where: any = {};

//       // tanggal
//       if (date_from || date_to) {
//         where.createdAt = {};
//         if (date_from) where.createdAt.gte = new Date(date_from + "T00:00:00");
//         if (date_to) where.createdAt.lte = new Date(date_to + "T23:59:59");
//       }

//       if (method) where.method = method;

//       if (user.role === "kasir") {
//         where.cashierId = user.id;
//       } else if (cashierId) {
//         where.cashierId = cashierId;
//       }

//       // search sederhana pada sale.number atau sku/name di lines (opsional)
//       // untuk search sku/name, kita perlu include lines+product lalu filter manual.
//       const include: any = {
//         cashier: { select: { username: true } },
//       };
//       if (detail || q) {
//         include.lines = {
//           include: { product: { select: { sku: true, name: true } } },
//         };
//       }

//       const rows = await prisma.sale.findMany({
//         where,
//         orderBy: { createdAt: "desc" },
//         include,
//       });

//       // filter manual q untuk sku/name bila ada
//       let filtered = rows;
//       if (q && (detail || include.lines)) {
//         const qq = q.toLowerCase();
//         filtered = rows.filter((s) => {
//           if (s.number.toLowerCase().includes(qq)) return true;
//           if (!s.lines) return false;
//           return s.lines.some(
//             (l) =>
//               l.product?.sku?.toLowerCase().includes(qq) ||
//               l.product?.name?.toLowerCase().includes(qq) ||
//               l.uom.toLowerCase().includes(qq) // <— tambahkan ini
//           );
//         });
//       } else if (q) {
//         const qq = q.toLowerCase();
//         filtered = rows.filter((s) => s.number.toLowerCase().includes(qq));
//       }

//       if (!detail) {
//         // ringkas
//         return reply.send({
//           ok: true,
//           data: filtered.map((s) => ({
//             id: s.id,
//             number: s.number,
//             cashier: s.cashier?.username ?? s.cashierId,
//             method: s.method,
//             total: Number(s.total),
//             createdAt: s.createdAt,
//           })),
//         });
//       }

//       // detail dengan lines
//       return reply.send({
//         ok: true,
//         data: filtered.map((s) => ({
//           id: s.id,
//           number: s.number,
//           cashier: s.cashier?.username ?? s.cashierId,
//           method: s.method,
//           subtotal: Number(s.subtotal),
//           discount: Number(s.discount),
//           total: Number(s.total),
//           createdAt: s.createdAt,
//           lines:
//             s.lines?.map((l) => ({
//               productId: l.productId,
//               sku: l.product?.sku,
//               name: l.product?.name,
//               uom: l.uom,
//               qty: Number(l.qty),
//               price: Number(l.price),
//               discount: Number(l.discount),
//               subtotal: Number(l.subtotal),
//             })) ?? [],
//         })),
//       });
//     }
//   );
// }
