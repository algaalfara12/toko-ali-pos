// packages/api/src/routes/adminStoreProfile.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import { requireRoles } from "../utils/roleGuard";

export default async function adminStoreProfileRoutes(app: FastifyInstance) {
  app.get(
    "/admin/store-profile",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (_req, reply) => {
      const profile = await prisma.storeProfile.findFirst();
      if (!profile) {
        return reply.send({
          ok: true,
          data: {
            name: "TOKO ALI POS",
            address: "",
            phone: "",
            logoUrl: null,
            footerNote: "",
            timezone: "Asia/Jakarta",
          },
        });
      }
      return reply.send({ ok: true, data: profile });
    }
  );

  app.put(
    "/admin/store-profile",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const bodySchema = z.object({
        name: z.string().min(1),
        address: z.string().optional(),
        phone: z.string().optional(),
        logoUrl: z.string().url().optional().nullable(),
        footerNote: z.string().optional(),
        timezone: z.string().optional(),
      });
      const p = bodySchema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const data = p.data;
      const existing = await prisma.storeProfile.findFirst();

      let updated;
      if (existing) {
        updated = await prisma.storeProfile.update({
          where: { id: existing.id },
          data,
        });
      } else {
        updated = await prisma.storeProfile.create({ data });
      }

      return reply.send({ ok: true, data: updated });
    }
  );
}
