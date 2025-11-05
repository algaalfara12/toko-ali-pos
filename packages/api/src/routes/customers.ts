import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";

export default async function customersRoutes(app: FastifyInstance) {
  // CREATE: hanya admin yang create (agar terkontrol)
  app.post(
    "/customers",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Body = z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        memberCode: z.string().optional(),
        isActive: z.coerce.boolean().optional().default(true),
      });

      const p = Body.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      const { name, phone, email, memberCode, isActive } = p.data;

      try {
        const c = await prisma.customer.create({
          data: {
            name: name ?? null,
            phone: phone ?? null,
            email: email ?? null,
            memberCode: memberCode ?? null,
            isActive,
          },
        });
        return reply.send({ ok: true, data: c });
      } catch (e: any) {
        // handle unique constraint
        if (String(e.message || "").includes("Unique")) {
          return reply.code(400).send({
            ok: false,
            error: "Phone/email/memberCode sudah digunakan",
          });
        }
        throw e;
      }
    }
  );

  // SEARCH/LIST: admin & kasir boleh cari
  app.get(
    "/customers",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const Q = z.object({
        q: z.string().optional(),
        page: z.coerce.number().int().positive().optional().default(1),
        pageSize: z.coerce
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .default(20),
        activeOnly: z.coerce.boolean().optional().default(false),
      });
      const p = Q.safeParse(req.query);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      const { q, page, pageSize, activeOnly } = p.data;

      const where: any = {};
      if (activeOnly) where.isActive = true;
      if (q && q.trim() !== "") {
        const s = q.trim();
        where.OR = [
          { name: { contains: s, mode: "insensitive" } },
          { phone: { contains: s, mode: "insensitive" } },
          { email: { contains: s, mode: "insensitive" } },
          { memberCode: { contains: s, mode: "insensitive" } },
        ];
      }

      const [total, rows] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({
          where,
          orderBy: { joinedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);

      return reply.send({ ok: true, page, pageSize, total, data: rows });
    }
  );

  // (Opsional) GET by id
  app.get(
    "/customers/:id",
    { preHandler: [requireRoles(app, ["admin", "kasir"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const c = await prisma.customer.findUnique({ where: { id } });
      if (!c)
        return reply
          .code(404)
          .send({ ok: false, error: "Customer tidak ditemukan" });
      return reply.send({ ok: true, data: c });
    }
  );

  // (Opsional) UPDATE: admin
  app.put(
    "/customers/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const Body = z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        memberCode: z.string().optional(),
        isActive: z.coerce.boolean().optional(),
      });
      const p = Body.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      try {
        const c = await prisma.customer.update({ where: { id }, data: p.data });
        return reply.send({ ok: true, data: c });
      } catch (e: any) {
        if (String(e.message || "").includes("Record to update not found")) {
          return reply
            .code(404)
            .send({ ok: false, error: "Customer tidak ditemukan" });
        }
        if (String(e.message || "").includes("Unique")) {
          return reply.code(400).send({
            ok: false,
            error: "Phone/email/memberCode sudah digunakan",
          });
        }
        throw e;
      }
    }
  );
}
