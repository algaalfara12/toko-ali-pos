import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../prisma';
import { requireRoles } from '../utils/roleGuard';

// util nomor hold
function dayRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0,0,0,0);
  const end   = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23,59,59,999);
  return { start, end };
}
async function nextHoldNumber(cashierCode: string) {
  const { start, end } = dayRange();
  const count = await prisma.posHold.count({ where: { createdAt: { gte: start, lte: end } } });
  const run = String(count + 1).padStart(4, '0');
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `HOLD-${y}${m}${day}-${cashierCode}-${run}`;
}

// skema payload items/payments (samakan dengan /pos/checkout agar gampang reconvert)
const itemSchema = z.object({
  productId: z.string().uuid(),
  locationCode: z.string().min(1),
  uom: z.string().min(1),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  discount: z.number().min(0).optional().default(0),
});
const paySchema = z.object({
  method: z.enum(['CASH','NON_CASH']),
  amount: z.number().nonnegative(),
  ref: z.string().optional().nullable()
});

// ============ ROUTES ============

export default async function posHoldRoutes(app: FastifyInstance) {
  // Buat hold baru
  app.post('/pos/hold', { preHandler: [requireRoles(app, ['admin','kasir'])] }, async (req, reply) => {
    const schema = z.object({
      cashierId: z.string().min(1),
      cashierCode: z.string().min(1),
      customerId: z.string().optional().nullable(),
      method: z.enum(['CASH','NON_CASH']),
      discountTotal: z.number().min(0).optional().default(0),
      items: z.array(itemSchema).min(1),
      payments: z.array(paySchema).optional().default([])
    });
    const p = schema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });

    const number = await nextHoldNumber(p.data.cashierCode);
    const hold = await prisma.posHold.create({
      data: {
        number,
        cashierId: p.data.cashierId,
        cashierCode: p.data.cashierCode,
        customerId: p.data.customerId ?? null,
        method: p.data.method,
        discountTotal: p.data.discountTotal ?? 0,
        items: p.data.items,
        payments: p.data.payments ?? []
      }
    });

    return reply.send({ ok:true, data: hold });
  });

  // List hold (opsional filter cashierId)
  app.get('/pos/holds', { preHandler: [requireRoles(app, ['admin','kasir'])] }, async (req, reply) => {
    const q = req.query as any;
    const cashierId = q.cashierId ? String(q.cashierId) : undefined;

    const holds = await prisma.posHold.findMany({
      where: cashierId ? { cashierId } : undefined,
      orderBy: { createdAt: 'desc' }
    });
    return reply.send({ ok:true, data: holds });
  });

  // Detail hold
  app.get('/pos/holds/:id', { preHandler: [requireRoles(app, ['admin','kasir'])] }, async (req, reply) => {
    const id = String((req.params as any).id);
    const hold = await prisma.posHold.findUnique({ where: { id } });
    if (!hold) return reply.code(404).send({ ok:false, error: 'Hold tidak ditemukan' });
    return reply.send({ ok:true, data: hold });
  });

  // Hapus hold (cancel)
    // Hapus hold (cancel) -- hanya jika status DRAFT
  app.delete('/pos/holds/:id', { preHandler: [requireRoles(app, ['admin','kasir'])] }, async (req, reply) => {
    const id = String((req.params as any).id);
    const hold = await prisma.posHold.findUnique({ where: { id } });
    if (!hold) return reply.code(404).send({ ok:false, error: 'Hold tidak ditemukan' });

    if ((hold as any).status && (hold as any).status !== 'DRAFT') {
      return reply.code(400).send({ ok:false, error: `Tidak bisa hapus hold dengan status ${ (hold as any).status }` });
    }

    await prisma.posHold.delete({ where: { id } });
    return reply.send({ ok:true, deletedId: id });
  });


  // Checkout dari hold → gunakan endpoint /pos/checkout (kita panggil logicnya)
  // Di sini kita baca payload hold lalu kirim balik ke /pos/checkout
  app.post('/pos/holds/:id/checkout', { preHandler: [requireRoles(app, ['admin','kasir'])] }, async (req, reply) => {
    const id = String((req.params as any).id);
    const hold = await prisma.posHold.findUnique({ where: { id } });
    if (!hold) return reply.code(404).send({ ok:false, error: 'Hold tidak ditemukan' });
        // pastikan cashierId valid (hindari FK error)
    const kasir = await prisma.user.findUnique({ where: { id: hold.cashierId } });
    if (!kasir) {
      return reply.code(400).send({ ok:false, error: `Kasir tidak ditemukan: ${hold.cashierId}` });
    }


    // Kita tidak import handler internal; cukup lakukan ulang perhitungan di route /pos/checkout yang sudah ada
    // Caranya: lempar request baru ke prisma dalam TRANSACTION di sini langsung,
    // atau paling simpel: copy paste pola /pos/checkout (biar mandiri).
    // -> Untuk hemat, kita panggil ulang logika minimal: hitung subtotal/total + validasi stok + tulis Sale + StockMove + Payment, lalu hapus hold.

    // Ambil data dari hold
    const payload: any = {
      cashierId: hold.cashierId,
      cashierCode: hold.cashierCode,
      customerId: hold.customerId,
      method: hold.method,
      discountTotal: Number(hold.discountTotal),
      items: hold.items as any[],
      payments: (hold.payments as any[]) ?? []
    };

    // ==== Validasi stok mirip /pos/checkout (pakai konversi base) ====
    // siapkan cache lokasi & toBase
    const locMap = new Map<string,string>();
    const productIds = Array.from(new Set(payload.items.map((i:any) => i.productId)));
    const uomRows = await prisma.productUom.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true, uom: true, toBase: true }
    });
    const toBaseMap = new Map<string, number>();
    for (const r of uomRows) toBaseMap.set(`${r.productId}::${r.uom}`, r.toBase);
    const getToBase = (pid: string, uom: string) => toBaseMap.get(`${pid}::${uom}`);

    const shortages: Array<{productId:string; locationCode:string; need:number; have:number; uom:string}> = [];
    for (const it of payload.items) {
      if (!locMap.has(it.locationCode)) {
        const loc = await prisma.location.findUnique({ where: { code: it.locationCode } });
        if (!loc) return reply.code(400).send({ ok:false, error:`Lokasi tidak ditemukan: ${it.locationCode}` });
        locMap.set(it.locationCode, loc.id);
      }
      const tbItem = getToBase(it.productId, it.uom);
      if (!tbItem) return reply.code(400).send({ ok:false, error:`UOM ${it.uom} belum terdaftar pada produk` });

      const needBase = it.qty * tbItem;
      const locationId = locMap.get(it.locationCode)!;

      const moves = await prisma.stockMove.findMany({
        where: { productId: it.productId, locationId },
        select: { qty: true, uom: true }
      });

      let haveBase = 0;
      for (const m of moves) {
        const tb = getToBase(it.productId, m.uom);
        if (!tb) continue;
        haveBase += Number(m.qty) * tb;
      }
      if (haveBase < needBase) {
        shortages.push({ productId: it.productId, locationCode: it.locationCode, need: needBase, have: haveBase, uom: it.uom });
      }
    }
    if (shortages.length) return reply.code(400).send({ ok:false, error:'Stok tidak cukup', shortages });

    // hitung ringkasan
    const subtotal = payload.items.reduce((s:number, it:any) => s + (it.qty * it.price - (it.discount ?? 0)), 0);
    const total = Math.max(0, subtotal - (payload.discountTotal ?? 0));
    const paid  = payload.payments.reduce((s:number, p:any) => s + (p.amount||0), 0);
    const change = Math.max(0, paid - total);

    // buat nomor sale (copy fungsi dari pos.ts – kita paste mini helper di sini supaya mandiri)
    function dateParts() {
      const d = new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0'); const day=String(d.getDate()).padStart(2,'0');
      return `${y}${m}${day}`;
    }
    async function nextSaleNumber(cashierCode: string) {
      const { start, end } = dayRange();
      const countToday = await prisma.sale.count({ where: { createdAt: { gte: start, lte: end } } });
      const running = String(countToday + 1).padStart(4,'0');
      return `TOKOAL-${dateParts()}-${cashierCode}-${running}`;
    }

    // transaksi atomik: create Sale + Lines + Payments + StockMove, lalu delete hold
    const sale = await prisma.$transaction(async (tx) => {
      const saleNumber = await nextSaleNumber(payload.cashierCode);

      const sale = await tx.sale.create({
        data: {
          number: saleNumber,
          cashierId: payload.cashierId,
          customerId: payload.customerId ?? null,
          method: payload.method,
          subtotal,
          discount: payload.discountTotal ?? 0,
          tax: 0,
          total,
          paid,
          change
        }
      });

      for (const it of payload.items) {
        await tx.saleLine.create({
          data: {
            saleId: sale.id,
            productId: it.productId,
            uom: it.uom,
            qty: it.qty,
            price: it.price,
            discount: it.discount ?? 0,
            subtotal: it.qty * it.price - (it.discount ?? 0)
          }
        });
        const locationId = locMap.get(it.locationCode)!;
        await tx.stockMove.create({
          data: {
            productId: it.productId,
            locationId,
            qty: -it.qty,
            uom: it.uom,
            type: 'SALE',
            refId: sale.id
          }
        });
      }

      for (const p of (payload.payments ?? [])) {
        await tx.payment.create({
          data: { saleId: sale.id, method: p.method, amount: p.amount, ref: p.ref ?? null }
        });
      }

      await tx.posHold.delete({ where: { id: hold.id } });

      return sale;
    });

    return reply.send({ ok:true, data: { id: sale.id, number: sale.number, total: Number(sale.total), paid: Number(sale.paid), change: Number(sale.change) } });
  });
}
