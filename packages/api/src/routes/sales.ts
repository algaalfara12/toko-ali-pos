import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../prisma';

function nextSaleNumber(d = new Date(), cashierCode = 'K1', running = 1) {
  const pad = (n: number) => String(n).padStart(4, '0');
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `TOKOAL-${yyyy}${mm}${dd}-${cashierCode}-${pad(running)}`;
}

export default async function salesRoutes(app: FastifyInstance) {
  // Checkout
  app.post('/sales/checkout', async (req, reply) => {
    const schema = z.object({
      cashierId: z.string().min(1),         // misal user.id atau kode kasir
      cashierCode: z.string().min(1),       // misal "RKI"
      method: z.enum(['CASH','NON_CASH']),
      discountTotal: z.number().nonnegative().default(0),
      lines: z.array(z.object({
        productId: z.string().uuid(),
        locationCode: z.string().min(1),
        uom: z.string().min(1),
        qty: z.number().positive(),
        price: z.number().nonnegative(),
        discount: z.number().nonnegative().default(0),
      })).min(1),
      payments: z.array(z.object({
        method: z.enum(['CASH','NON_CASH']),
        amount: z.number().nonnegative(),
        ref: z.string().optional()
      })).min(1)
    });

    const p = schema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });
    const { cashierId, cashierCode, method, discountTotal, lines, payments } = p.data;

    // Hitung subtotal & total
    const subtotal = lines.reduce((s,l)=> s + (l.qty*l.price - (l.discount||0)), 0);
    const total = Math.max(0, subtotal - (discountTotal||0));
    const paid  = payments.reduce((s,p)=> s + p.amount, 0);
    const change = Math.max(0, paid - total);

    // Ambil running number harian per kasir sederhana (pakai count)
    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    const todayEnd = new Date();
    todayEnd.setHours(23,59,59,999);

    const running = await prisma.sale.count({
      where: { createdAt: { gte: todayStart, lte: todayEnd }, }
    }) + 1;
    const number = nextSaleNumber(new Date(), cashierCode, running);

    // Transaksi atomik
    const result = await prisma.$transaction(async (tx) => {
      // Validasi lokasi untuk setiap line
      const locationIds: Record<string,string> = {};
      for (const l of lines) {
        if (!locationIds[l.locationCode]) {
          const loc = await tx.location.findUnique({ where: { code: l.locationCode } });
          if (!loc) throw new Error(`Lokasi tidak ditemukan: ${l.locationCode}`);
          locationIds[l.locationCode] = loc.id;
        }
      }

      // (Opsional) validasi UOM per product
      for (const l of lines) {
        const uomOk = await tx.productUom.findFirst({ where: { productId: l.productId, uom: l.uom } });
        if (!uomOk) throw new Error(`UOM ${l.uom} belum terdaftar pada produk`);
      }

      // (Opsional) validasi saldo stok cukup (sum ledger)
      for (const l of lines) {
        const rows = await tx.stockMove.groupBy({
          by: ['productId','locationId'],
          where: { productId: l.productId, locationId: locationIds[l.locationCode] },
          _sum: { qty: true }
        });
        const balance = Number(rows[0]?._sum.qty ?? 0);
        if (balance < l.qty) throw new Error(`Stok kurang untuk productId ${l.productId} di ${l.locationCode}. Sisa: ${balance}`);
      }

      // Buat Sale
      const sale = await tx.sale.create({
        data: {
          number, cashierId, method,
          subtotal, discount: discountTotal||0, tax: 0, total, paid, change
        }
      });

      // Lines + StockMove SALE (qty negatif)
      for (const l of lines) {
        await tx.saleLine.create({
          data: {
            saleId: sale.id,
            productId: l.productId,
            uom: l.uom,
            qty: l.qty,
            price: l.price,
            discount: l.discount||0,
            subtotal: (l.qty*l.price - (l.discount||0))
          }
        });

        await tx.stockMove.create({
          data: {
            productId: l.productId,
            locationId: locationIds[l.locationCode],
            qty: -l.qty,          // SALE = negatif
            uom: l.uom,
            type: 'SALE',
            refId: sale.id
          }
        });
      }

      // Payments
      for (const pmt of payments) {
        await tx.payment.create({
          data: {
            saleId: sale.id, method: pmt.method, amount: pmt.amount, ref: pmt.ref ?? null
          }
        });
      }

      // Kembalikan ringkasan
      return await tx.sale.findUnique({
        where: { id: sale.id },
        include: { lines: true, payments: true }
      });
    });

    return reply.send({ ok: true, data: result });
  });

    // === LIST PENJUALAN: GET /sales?page=1&pageSize=20&q=keyword (opsional) ===
  app.get('/sales', async (req, reply) => {
    const q = req.query as any;
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));
    const keyword = (q.q ? String(q.q) : '').trim();

    const where: any = keyword
      ? {
          OR: [
            { number: { contains: keyword } },
            {
              lines: {
                some: {
                  product: {
                    OR: [
                      { sku:  { contains: keyword } },
                      { name: { contains: keyword } }
                    ]
                  }
                }
              }
            }
          ]
        }
      : undefined;

    const [total, rows] = await Promise.all([
      prisma.sale.count({ where }),
      prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          lines: { include: { product: { select: { sku: true, name: true } } } },
          payments: true
        }
      })
    ]);

    return reply.send({
      ok: true,
      page,
      pageSize,
      total,
      data: rows.map(s => ({
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
        lines: s.lines.map(l => ({
          productId: l.productId,
          sku: l.product.sku,
          name: l.product.name,
          uom: l.uom,
          qty: Number(l.qty),
          price: Number(l.price),
          discount: Number(l.discount),
          subtotal: Number(l.subtotal)
        })),
        payments: s.payments.map(p => ({
          method: p.method,
          amount: Number(p.amount),
          ref: p.ref,
          createdAt: p.createdAt
        }))
      }))
    });
  });

  // === DETAIL PENJUALAN: GET /sales/:id ===
  app.get('/sales/:id', async (req, reply) => {
    const id = String((req.params as any).id);
    const s = await prisma.sale.findUnique({
      where: { id },
      include: {
        lines: { include: { product: { select: { sku: true, name: true } } } },
        payments: true
      }
    });
    if (!s) return reply.code(404).send({ ok: false, error: 'Sale tidak ditemukan' });

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
        lines: s.lines.map(l => ({
          productId: l.productId,
          sku: l.product.sku,
          name: l.product.name,
          uom: l.uom,
          qty: Number(l.qty),
          price: Number(l.price),
          discount: Number(l.discount),
          subtotal: Number(l.subtotal)
        })),
        payments: s.payments.map(p => ({
          method: p.method,
          amount: Number(p.amount),
          ref: p.ref,
          createdAt: p.createdAt
        }))
      }
    });
  });
}
