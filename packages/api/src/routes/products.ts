import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";

export default async function productsRoutes(app: FastifyInstance) {
  // === CREATE product (admin) ===
  app.post(
    "/admin/products",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const schema = z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
        baseUom: z.string().min(1),
        isActive: z.boolean().optional().default(true),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      // cek sku unik
      const exist = await prisma.product.findUnique({
        where: { sku: p.data.sku },
      });
      if (exist)
        return reply
          .code(409)
          .send({ ok: false, error: `SKU sudah digunakan: ${p.data.sku}` });

      const prod = await prisma.product.create({ data: p.data });
      return reply.send({ ok: true, data: prod });
    }
  );

  // === LIST products (GET: admin/kasir/gudang) ===
  app.get(
    "/admin/products",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
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
      const parsed = Q.safeParse(req.query);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, error: parsed.error.flatten() });

      const { q, page, pageSize, activeOnly } = parsed.data;
      const where: any = {};
      if (q) {
        where.OR = [{ sku: { contains: q } }, { name: { contains: q } }];
      }
      if (activeOnly) where.isActive = true;

      const [total, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            sku: true,
            name: true,
            baseUom: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

      return reply.send({ ok: true, page, pageSize, total, data: rows });
    }
  );

  // === DETAIL product ===
  app.get(
    "/admin/products/:id",
    { preHandler: [requireRoles(app, ["admin", "kasir", "petugas_gudang"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const prod = await prisma.product.findUnique({
        where: { id },
        include: {
          uoms: true,
          prices: true,
          barcodes: true,
        },
      });
      if (!prod)
        return reply
          .code(404)
          .send({ ok: false, error: "Product tidak ditemukan" });
      return reply.send({ ok: true, data: prod });
    }
  );

  // === UPDATE product (admin) ===
  app.put(
    "/admin/products/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const schema = z.object({
        sku: z.string().min(1),
        name: z.string().min(1),
        baseUom: z.string().min(1),
        isActive: z.boolean().optional(),
      });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      // pastikan id ada
      const old = await prisma.product.findUnique({ where: { id } });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "Product tidak ditemukan" });

      // cek sku unik (kecuali dirinya)
      const dup = await prisma.product.findUnique({
        where: { sku: p.data.sku },
      });
      if (dup && dup.id !== id) {
        return reply
          .code(409)
          .send({ ok: false, error: `SKU sudah digunakan: ${p.data.sku}` });
      }

      const upd = await prisma.product.update({
        where: { id },
        data: p.data,
      });
      return reply.send({ ok: true, data: upd });
    }
  );

  // === DEACTIVATE/ACTIVATE product (admin) ===
  app.patch(
    "/admin/products/:id/active",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const schema = z.object({ isActive: z.boolean() });
      const p = schema.safeParse(req.body);
      if (!p.success)
        return reply.code(400).send({ ok: false, error: p.error.flatten() });

      const old = await prisma.product.findUnique({ where: { id } });
      if (!old)
        return reply
          .code(404)
          .send({ ok: false, error: "Product tidak ditemukan" });

      const upd = await prisma.product.update({
        where: { id },
        data: { isActive: p.data.isActive },
      });
      return reply.send({ ok: true, data: upd });
    }
  );

  // === DELETE aman (admin) → tolak kalau sudah dipakai ===
  app.delete(
    "/admin/products/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const id = String((req.params as any).id);
      const prod = await prisma.product.findUnique({ where: { id } });
      if (!prod)
        return reply
          .code(404)
          .send({ ok: false, error: "Product tidak ditemukan" });

      // 1) Cek referensi TRANSAKSIONAL (HARUS blokir jika > 0)
      const [inUse1, inUse2, inUse3, inUse4, inUse5] = await Promise.all([
        prisma.stockMove.count({ where: { productId: id } }),
        prisma.saleLine.count({ where: { productId: id } }),
        prisma.purchaseLine.count({ where: { productId: id } }),
        prisma.repackInput.count({ where: { productId: id } }),
        prisma.repackOutput.count({ where: { productId: id } }),
      ]);
      const refCount = inUse1 + inUse2 + inUse3 + inUse4 + inUse5;
      if (refCount > 0) {
        return reply.code(409).send({
          ok: false,
          error:
            "Produk sudah digunakan dalam transaksi. Nonaktifkan saja jika tidak dipakai.",
          refs: {
            stockMoves: inUse1,
            saleLines: inUse2,
            purchaseLines: inUse3,
            repackInputs: inUse4,
            repackOutputs: inUse5,
          },
        });
      }

      // 2) Tidak ada referensi transaksional → boleh hapus
      //    Hapus dulu anak master (PriceList, Barcode, ProductUom) agar tidak kena FK error.
      await prisma.$transaction(async (tx) => {
        await tx.priceList.deleteMany({ where: { productId: id } });
        await tx.barcode.deleteMany({ where: { productId: id } });
        await tx.productUom.deleteMany({ where: { productId: id } });

        await tx.product.delete({ where: { id } });
      });

      return reply.send({ ok: true, deletedId: id });
    }
  );
}
