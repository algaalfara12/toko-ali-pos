import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";

export default async function locationsRoutes(app: FastifyInstance) {
  // CREATE (admin)
  app.post(
    "/admin/locations",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const schema = z.object({
        code: z.string().min(1),
        name: z.string().min(1),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const code = p.data.code.toUpperCase();
      const dup = await prisma.location.findUnique({ where: { code } });
      if (dup)
        return reply
          .code(409)
          .send({ ok: false, error: `Kode lokasi sudah dipakai: ${code}` });

      const created = await prisma.location.create({
        data: { code, name: p.data.name },
      });
      return reply.send({ ok: true, data: created });
    }
  );

  // LIST (read-only)
  app.get(
    "/admin/locations",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (_req, reply) => {
      const rows = await prisma.location.findMany({ orderBy: { code: "asc" } });
      return reply.send({ ok: true, data: rows });
    }
  );

  // UPDATE (admin) — ubah name; ubah code perlu cek unik
  app.put(
    "/admin/locations/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const schema = z.object({
        code: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const old = await prisma.location.findUnique({ where: { id } });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "Lokasi tidak ditemukan" });

      let newCode = old.code;
      if (p.data.code) {
        newCode = p.data.code.toUpperCase();
        if (newCode !== old.code) {
          const dup = await prisma.location.findUnique({
            where: { code: newCode },
          });
          if (dup)
            return reply
              .code(409)
              .send({ ok: false, error: `Kode sudah dipakai: ${newCode}` });
        }
      }

      const upd = await prisma.location.update({
        where: { id },
        data: { code: newCode, name: p.data.name ?? old.name },
      });
      return reply.send({ ok: true, data: upd });
    }
  );

  // DELETE aman (admin)
  app.delete(
    "/admin/locations/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const loc = await prisma.location.findUnique({ where: { id } });
      if (!loc)
        return reply
          .code(404)
          .send({ ok: false, error: "Lokasi tidak ditemukan" });

      const [m1, m2, m3] = await Promise.all([
        prisma.stockMove.count({ where: { locationId: id } }),
        prisma.purchase.count({ where: { locationId: id } }),
        prisma.saleReturn.count({ where: { locationId: id } }),
      ]);
      const ref = m1 + m2 + m3;
      if (ref > 0) {
        return reply.code(409).send({
          ok: false,
          error: "Lokasi sudah dipakai di transaksi. Tidak bisa dihapus.",
          refs: { stockMoves: m1, purchases: m2, saleReturns: m3 },
        });
      }

      await prisma.location.delete({ where: { id } });
      return reply.send({ ok: true, deletedId: id });
    }
  );
}
