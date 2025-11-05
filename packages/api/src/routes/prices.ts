import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";

export default async function pricesRoutes(app: FastifyInstance) {
  // CREATE (admin)
  app.post(
    "/admin/products/:productId/prices",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const productId = String((req.params as any).productId);
      const schema = z.object({
        uom: z.string().min(1),
        price: z.coerce.number().nonnegative(),
        active: z.boolean().optional().default(true),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const prod = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!prod)
        return reply
          .code(404)
          .send({ ok: false, error: "Product tidak ditemukan" });

      // pastikan UOM terdaftar
      const uomOk = await prisma.productUom.findUnique({
        where: { productId_uom: { productId, uom: p.data.uom } },
      });
      if (!uomOk)
        return reply.code(400).send({
          ok: false,
          error: `UOM ${p.data.uom} belum terdaftar untuk produk`,
        });

      const created = await prisma.$transaction(async (tx) => {
        if (p.data.active) {
          await tx.priceList.updateMany({
            where: { productId, uom: p.data.uom, active: true },
            data: { active: false },
          });
        }
        return tx.priceList.create({
          data: {
            productId,
            uom: p.data.uom,
            price: p.data.price,
            active: p.data.active,
          },
        });
      });

      return reply.send({ ok: true, data: created });
    }
  );

  // LIST price (GET)
  app.get(
    "/admin/products/:productId/prices",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (req, reply) => {
      const productId = String((req.params as any).productId);
      const prod = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!prod)
        return reply
          .code(404)
          .send({ ok: false, error: "Product tidak ditemukan" });

      const rows = await prisma.priceList.findMany({
        where: { productId },
        orderBy: [{ uom: "asc" }, { active: "desc" }],
      });
      return reply.send({ ok: true, data: rows });
    }
  );

  // UPDATE price (admin) — bisa ubah price/active
  app.put(
    "/admin/prices/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const schema = z.object({
        price: z.coerce.number().nonnegative().optional(),
        active: z.boolean().optional(),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const old = await prisma.priceList.findUnique({ where: { id } });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "Price tidak ditemukan" });

      const upd = await prisma.$transaction(async (tx) => {
        if (p.data.active === true) {
          await tx.priceList.updateMany({
            where: {
              productId: old.productId,
              uom: old.uom,
              active: true,
              NOT: { id },
            },
            data: { active: false },
          });
        }
        return tx.priceList.update({
          where: { id },
          data: {
            price: p.data.price ?? old.price,
            active: p.data.active ?? old.active,
          },
        });
      });

      return reply.send({ ok: true, data: upd });
    }
  );

  // DELETE price (admin)
  app.delete(
    "/admin/prices/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const old = await prisma.priceList.findUnique({ where: { id } });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "Price tidak ditemukan" });

      await prisma.priceList.delete({ where: { id } });
      return reply.send({ ok: true, deletedId: id });
    }
  );
}
