import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";

export default async function productUomsRoutes(app: FastifyInstance) {
  // CREATE
  app.post(
    "/admin/products/:productId/uoms",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const productId = String((req.params as any).productId);
      const schema = z.object({
        uom: z.string().min(1),
        toBase: z.coerce.number().int().positive(),
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

      const dup = await prisma.productUom.findUnique({
        where: { productId_uom: { productId, uom: p.data.uom } },
      });
      if (dup)
        return reply.code(409).send({
          ok: false,
          error: `UOM sudah ada untuk product ini: ${p.data.uom}`,
        });

      const u = await prisma.productUom.create({
        data: { productId, uom: p.data.uom, toBase: p.data.toBase },
      });
      return reply.send({ ok: true, data: u });
    }
  );

  // LIST
  app.get(
    "/admin/products/:productId/uoms",
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

      const rows = await prisma.productUom.findMany({
        where: { productId },
        orderBy: { uom: "asc" },
      });
      return reply.send({ ok: true, data: rows });
    }
  );

  // UPDATE (ubah uom/toBase)
  app.put(
    "/admin/products/:productId/uoms/:uom",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const productId = String((req.params as any).productId);
      const uomKey = String((req.params as any).uom);
      const schema = z.object({
        newUom: z.string().min(1),
        toBase: z.coerce.number().int().positive(),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const old = await prisma.productUom.findUnique({
        where: { productId_uom: { productId, uom: uomKey } },
      });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "UOM tidak ditemukan" });

      // jika newUom beda, cek unik
      if (p.data.newUom !== uomKey) {
        const dup = await prisma.productUom.findUnique({
          where: { productId_uom: { productId, uom: p.data.newUom } },
        });
        if (dup)
          return reply
            .code(409)
            .send({ ok: false, error: `UOM sudah ada: ${p.data.newUom}` });
      }

      const upd = await prisma.productUom.update({
        where: { productId_uom: { productId, uom: uomKey } },
        data: { uom: p.data.newUom, toBase: p.data.toBase },
      });
      return reply.send({ ok: true, data: upd });
    }
  );

  // DELETE aman
  app.delete(
    "/admin/products/:productId/uoms/:uom",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const productId = String((req.params as any).productId);
      const uom = String((req.params as any).uom);

      const old = await prisma.productUom.findUnique({
        where: { productId_uom: { productId, uom } },
      });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "UOM tidak ditemukan" });

      // cek referensi
      const [use1, use2, use3] = await Promise.all([
        prisma.saleLine.count({ where: { productId, uom } }),
        prisma.purchaseLine.count({ where: { productId, uom } }),
        prisma.stockMove.count({ where: { productId, uom } }),
      ]);
      const ref = use1 + use2 + use3;
      if (ref > 0) {
        return reply.code(409).send({
          ok: false,
          error: "UOM sudah dipakai di transaksi. Tidak bisa dihapus.",
        });
      }

      await prisma.productUom.delete({
        where: { productId_uom: { productId, uom } },
      });
      return reply.send({ ok: true, deleted: { productId, uom } });
    }
  );
}
