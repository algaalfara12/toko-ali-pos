import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../prisma';

// Aturan auto-barcode (bisa kamu ubah nanti)
function makeBarcode(sku: string, uom: string) {
  const normSku = sku.trim().toUpperCase().replace(/\s+/g, '-');
  const normUom = uom.trim().toUpperCase().replace(/\s+/g, '_');
  return `TA-${normSku}-${normUom}`;
}

export default async function productRoutes(app: FastifyInstance) {
  // Buat produk baru + UOM + barcode auto
  app.post('/products', async (req, reply) => {
    const schema = z.object({
      sku: z.string().min(1, 'kode/sku wajib'),
      name: z.string().min(1, 'nama wajib'),
      baseUom: z.string().min(1, 'baseUom wajib'), // contoh "gram"
      uoms: z.array(z.string().min(1)).min(1, 'minimal 1 UOM'), // contoh ["karung_50kg","bungkus_1kg"]
      toBase: z.record(z.string(), z.number().int().positive()).optional() // opsi: mapping konversi
    });

    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ ok: false, error: parse.error.flatten() });
    }
    const { sku, name, baseUom, uoms, toBase } = parse.data;

    // Cek SKU unik
    const exists = await prisma.product.findUnique({ where: { sku } });
    if (exists) return reply.code(409).send({ ok: false, error: 'SKU sudah ada' });

    // Transaksi: insert product + uoms + barcodes
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { sku, name, baseUom }
      });

      for (const uom of uoms) {
        // toBase default = 1 (kalau tidak diberikan)
        const tb = toBase?.[uom] ?? 1;
        await tx.productUom.create({
          data: { productId: product.id, uom, toBase: tb }
        });

        // barcode auto dari aturan
        const code = makeBarcode(sku, uom);
        await tx.barcode.create({
          data: { productId: product.id, uom, code }
        });
      }

      // ambil lengkap untuk respons
      const full = await tx.product.findUnique({
        where: { id: product.id },
        include: { uoms: true, barcodes: true, prices: true }
      });
      return full!;
    });

    reply.send({ ok: true, data: result });
  });

  // (Bonus) Cari produk cepat: nama/kode/barcode
  app.get('/products/search', async (req, reply) => {
    const q = String((req.query as any)?.q ?? '');
    const items = await prisma.product.findMany({
    where: {
        OR: [
        { name: { contains: q } },
        { sku:  { contains: q } },
        { barcodes: { some: { code: { contains: q } } } }
        ],
        isActive: true
    },
    include: { uoms: true, barcodes: true, prices: true }
    });
    reply.send({ ok: true, data: items });
  });
}
