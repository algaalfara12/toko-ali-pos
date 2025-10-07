import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../prisma';
import { requireRoles } from '../utils/roleGuard';

// util nomor retur
function dayRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0,0,0,0);
  const end   = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23,59,59,999);
  return { start, end };
}
async function nextReturnNumber() {
  const { start, end } = dayRange();
  const count = await prisma.saleReturn.count({ where: { createdAt: { gte: start, lte: end } } });
  const run = String(count + 1).padStart(4, '0');
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `RTN-${y}${m}${day}-${run}`;
}

// payload
const itemSchema = z.object({
  productId: z.string().uuid(),
  uom: z.string().min(1),
  qty: z.number().positive(),        // jumlah yang dikembalikan (dlm UOM baris)
  price: z.number().nonnegative()    // harga/unit untuk hitung refund (boleh ambil dari histori atau input)
});

const createSchema = z.object({
  saleId: z.string().uuid(),
  cashierId: z.string().min(1),
  locationCode: z.string().min(1),   // stok kembali ke mana (contoh: ETALASE atau GUDANG)
  reason: z.string().optional(),
  items: z.array(itemSchema).min(1)
});

export default async function posReturnRoutes(app: FastifyInstance) {

  // POST /pos/returns  -> buat retur + kembalikan stok
  app.post('/pos/returns', { preHandler: [requireRoles(app, ['admin','kasir'])] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });
    const { saleId, cashierId, locationCode, reason, items } = p.data;

    // Validasi sale, kasir, lokasi
    const [sale, kasir, loc] = await Promise.all([
      prisma.sale.findUnique({ where: { id: saleId }, include: { lines: true } }),
      prisma.user.findUnique({ where: { id: cashierId } }),
      prisma.location.findUnique({ where: { code: locationCode } }),
    ]);
    if (!sale)  return reply.code(404).send({ ok:false, error: 'Sale tidak ditemukan' });
    if (!kasir) return reply.code(400).send({ ok:false, error: `Kasir tidak ditemukan: ${cashierId}` });
    if (!loc)   return reply.code(400).send({ ok:false, error: `Lokasi tidak ditemukan: ${locationCode}` });

    // cache toBase untuk validasi base jika perlu
    const productIds = Array.from(new Set(items.map(i => i.productId)));
    const uomRows = await prisma.productUom.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, uom: true, toBase: true }
    });
    const toBase = new Map<string, number>();
    for (const r of uomRows) toBase.set(`${r.productId}::${r.uom}`, r.toBase);
    const getTB = (pid: string, uom: string) => toBase.get(`${pid}::${uom}`);

    // Hitung penjuaIan per produk/uom dari sale asal
    // (di model kita, SaleLine tidak menyimpan lokasi; retur bisa ke lokasi manapun yang kamu tentukan)
    const soldMap = new Map<string, number>(); // key: pid::uom -> qty sold
    for (const l of sale.lines) {
      const key = `${l.productId}::${l.uom}`;
      soldMap.set(key, (soldMap.get(key) ?? 0) + Number(l.qty));
    }

    // Hitung total yang SUDAH diretur untuk sale ini (jangan sampai over-return)
    const returnedRows = await prisma.saleReturnLine.findMany({
      where: { ret: { saleId } },
      select: { productId: true, uom: true, qty: true }
    });
    const returnedMap = new Map<string, number>();
    for (const r of returnedRows) {
      const key = `${r.productId}::${r.uom}`;
      returnedMap.set(key, (returnedMap.get(key) ?? 0) + Number(r.qty));
    }

    // Validasi: qty return <= (sold - alreadyReturned)
    const violations: Array<{productId:string; uom:string; sold:number; alreadyReturned:number; tryReturn:number}> = [];
    for (const it of items) {
      const key = `${it.productId}::${it.uom}`;
      const sold = soldMap.get(key) ?? 0;
      const already = returnedMap.get(key) ?? 0;
      const remain = sold - already;
      if (it.qty > remain + 1e-9) {
        violations.push({ productId: it.productId, uom: it.uom, sold, alreadyReturned: already, tryReturn: it.qty });
      }
      // cek UOM terdaftar
      if (!getTB(it.productId, it.uom)) {
        return reply.code(400).send({ ok:false, error: `UOM ${it.uom} belum terdaftar pada produk ${it.productId}` });
      }
    }
    if (violations.length) {
      return reply.code(400).send({ ok:false, error:'Qty retur melebihi qty jual', violations });
    }

    // Subtotal retur (nilai refund teoritis) — bisa kamu kembangkan jadi payment refund
    const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);

    // Transaksi atomik: create header, lines, stockMoves RETURN
    const res = await prisma.$transaction(async (tx) => {
      const number = await nextReturnNumber();
      const header = await tx.saleReturn.create({
        data: {
          number,
          saleId,
          cashierId,
          locationId: loc.id,
          reason: reason ?? null,
          subtotal
        }
      });

      for (const it of items) {
        await tx.saleReturnLine.create({
          data: {
            returnId: header.id,
            productId: it.productId,
            uom: it.uom,
            qty: it.qty,
            price: it.price,
            subtotal: it.qty * it.price
          }
        });

        // Stock kembali (qty positif)
        await tx.stockMove.create({
          data: {
            productId: it.productId,
            locationId: loc.id,
            qty: it.qty,
            uom: it.uom,
            type: 'RETURN',
            refId: header.id
          }
        });
      }

      return header;
    });

    return reply.send({ ok:true, data: { id: res.id, number: res.number, subtotal: Number(res.subtotal) } });
  });

  // GET /pos/returns/:id  -> detail retur
  app.get('/pos/returns/:id', { preHandler: [requireRoles(app, ['admin','kasir','petugas_gudang'])] }, async (req, reply) => {
    const id = String((req.params as any).id);
    const ret = await prisma.saleReturn.findUnique({
      where: { id },
      include: {
        location: { select: { code: true, name: true } },
        sale: { select: { number: true, createdAt: true } },
        lines: { include: { product: { select: { sku:true, name:true } } } }
      }
    });
    if (!ret) return reply.code(404).send({ ok:false, error: 'Return tidak ditemukan' });

    return reply.send({
      ok: true,
      data: {
        id: ret.id,
        number: ret.number,
        sale: ret.sale,
        location: ret.location,
        subtotal: Number(ret.subtotal),
        createdAt: ret.createdAt,
        lines: ret.lines.map(l => ({
          productId: l.productId,
          sku: l.product.sku,
          name: l.product.name,
          uom: l.uom,
          qty: Number(l.qty),
          price: Number(l.price),
          subtotal: Number(l.subtotal)
        }))
      }
    });
  });

    // GET /pos/returns  -> list retur terbaru
 // GET /pos/returns  -> list retur terbaru (dengan nama produk & qty)
app.get('/pos/returns', { preHandler: [requireRoles(app, ['admin','kasir','petugas_gudang'])] }, async (req, reply) => {
  const rows = await prisma.saleReturn.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      location: { select: { code: true, name: true } },
      sale: { select: { number: true } },
      lines: {
        include: {
          product: { select: { sku: true, name: true } }
        }
      }
    }
  });

  return reply.send({
    ok: true,
    data: rows.map(r => ({
      id: r.id,
      number: r.number,
      saleNumber: r.sale.number,
      location: r.location,
      subtotal: Number(r.subtotal),
      createdAt: r.createdAt,
      items: r.lines.map(l => ({
        productId: l.productId,
        sku: l.product.sku,
        name: l.product.name,
        uom: l.uom,
        qty: Number(l.qty),
        price: Number(l.price),
        subtotal: Number(l.subtotal)
      }))
    }))
  });
});


}
