import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../prisma';
import { requireRoles } from '../utils/roleGuard';

// Konversi qty dari uom → base (pakai ProductUom.toBase)
async function toBaseQty(productId: string, uom: string, qty: number) {
  const map = await prisma.productUom.findFirst({ where: { productId, uom } });
  if (!map) throw new Error(`UOM ${uom} belum terdaftar untuk produk`);
  return Number(map.toBase) * Number(qty);
}


export default async function stockRoutes(app: FastifyInstance) {
  // 1) Barang Masuk (IN) — single item
  app.post('/stock/in', async (req, reply) => {
    const schema = z.object({
      productId: z.string().uuid(),
      locationCode: z.string().min(1), // misal: "GUDANG" atau "ETALASE"
      qty: z.number().positive(),
      uom: z.string().min(1),
      refId: z.string().optional()
    });

    const p = schema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok: false, error: p.error.flatten() });

    const { productId, locationCode, qty, uom, refId } = p.data;

    // ambil locationId dari code
    const loc = await prisma.location.findUnique({ where: { code: locationCode } });
    if (!loc) return reply.code(404).send({ ok: false, error: 'Lokasi tidak ditemukan' });

    // (opsional) validasi UOM ada di productUom
    const uomOk = await prisma.productUom.findFirst({ where: { productId, uom } });
    if (!uomOk) return reply.code(400).send({ ok: false, error: 'UOM belum terdaftar pada produk' });

    const move = await prisma.stockMove.create({
      data: {
        productId,
        locationId: loc.id,
        qty,      // IN = positif
        uom,
        type: 'IN',
        refId: refId ?? null
      }
    });

    return reply.send({ ok: true, data: move });
  });

  // 2) Cek saldo (total per product/location)
  //    - jika productId & locationCode diberikan → satu angka
  //    - jika hanya productId → per lokasi
  //    - jika kosong → semua (ringkas)
  // GET /stock/balance?productId=...&locationCode=...[&uom=optional]
// - Mengembalikan saldo dalam BASE (baseUom produk)
// - Jika ?uom=... diberikan → juga kembalikan balanceInUom = balanceBase / toBase(uom)
    app.get('/stock/balance',{ preHandler: [requireRoles(app, ['admin','petugas_gudang'])] }, async (req, reply) => {
    try {
        const q = req.query as any;
        const productId = String(q.productId ?? '');
        const locationCode = String(q.locationCode ?? '');
        const outUom = q.uom ? String(q.uom) : null;

        if (!productId || !locationCode) {
        return reply.code(400).send({ ok:false, error:'productId & locationCode wajib' });
        }

        const loc = await prisma.location.findUnique({ where: { code: locationCode } });
        if (!loc) return reply.code(404).send({ ok:false, error:`Lokasi tidak ditemukan: ${locationCode}` });

        // Ambil semua moves produk+lokasi
        const moves = await prisma.stockMove.findMany({
        where: { productId, locationId: loc.id },
        orderBy: { createdAt: 'asc' },
        select: { qty: true, uom: true }
        });

        // Akumulasi dalam BASE
        let balanceBase = 0;
        for (const m of moves) {
        balanceBase += await toBaseQty(productId, m.uom, Number(m.qty));
        }

        let balanceInUom: number | undefined;
        if (outUom) {
        const u = await prisma.productUom.findFirst({ where: { productId, uom: outUom } });
        if (!u) return reply.code(400).send({ ok:false, error: `UOM ${outUom} belum terdaftar pada produk` });
        balanceInUom = balanceBase / Number(u.toBase);
        }

        return reply.send({
        ok: true,
        data: {
            productId,
            locationCode,
            balanceBase,                 // saldo dalam baseUom (mis. gram)
            ...(outUom ? { uom: outUom, balanceInUom } : {})
        }
        });
    } catch (err: any) {
        req.log.error(err);
        return reply.code(500).send({ ok:false, error: err?.message ?? 'Internal error' });
    }
    });

  // === Transfer stok antar lokasi ===
// Body:
// {
//   "productId": "uuid",
//   "fromLocationCode": "GUDANG",
//   "toLocationCode":   "ETALASE",
//   "uom": "bungkus_1kg",
//   "qty": 10,
//   "refId": "TF-0001"
// }
    app.post('/stock/transfer', { preHandler: [requireRoles(app, ['admin','petugas_gudang'])] }, async (req, reply) => {
    const b = req.body as any;
    try {
        const productId = String(b.productId);
        const fromCode  = String(b.fromLocationCode);
        const toCode    = String(b.toLocationCode);
        const uom       = String(b.uom);
        const qty       = Number(b.qty);
        const refId     = b.refId ? String(b.refId) : null;

        if (!productId || !fromCode || !toCode || !uom || !(qty > 0)) {
        return reply.code(400).send({ ok:false, error: 'Param tidak lengkap / qty harus > 0' });
        }
        if (fromCode === toCode) {
        return reply.code(400).send({ ok:false, error: 'Lokasi asal dan tujuan tidak boleh sama' });
        }

        const [fromLoc, toLoc] = await Promise.all([
        prisma.location.findUnique({ where: { code: fromCode } }),
        prisma.location.findUnique({ where: { code: toCode } }),
        ]);
        if (!fromLoc) return reply.code(400).send({ ok:false, error: `Lokasi asal tidak ditemukan: ${fromCode}` });
        if (!toLoc)   return reply.code(400).send({ ok:false, error: `Lokasi tujuan tidak ditemukan: ${toCode}` });

        // Pastikan UOM terdaftar di produk (opsional tapi disarankan)
        const uomOk = await prisma.productUom.findFirst({ where: { productId, uom } });
        if (!uomOk) return reply.code(400).send({ ok:false, error: `UOM ${uom} belum terdaftar pada produk` });

        // Hitung saldo asal (opsional → biar aman dari minus)
        const balFromRows = await prisma.stockMove.groupBy({
        by: ['productId','locationId'],
        where: { productId, locationId: fromLoc.id },
        _sum: { qty: true }
        });
        const balFrom = Number(balFromRows[0]?._sum.qty ?? 0);
        if (balFrom < qty) {
        return reply.code(400).send({ ok:false, error: `Stok tidak cukup di ${fromCode}. Sisa: ${balFrom}` });
        }

        // Transaksi atomik: 2 baris ledger
        const result = await prisma.$transaction(async (tx) => {
        const outMove = await tx.stockMove.create({
            data: {
            productId,
            locationId: fromLoc.id,
            qty: -qty,
            uom,
            type: 'TRANSFER',
            refId
            }
        });

        const inMove = await tx.stockMove.create({
            data: {
            productId,
            locationId: toLoc.id,
            qty: qty,
            uom,
            type: 'TRANSFER',
            refId
            }
        });

        return { outMove, inMove };
        });

        return reply.send({ ok:true, data: result });
    } catch (err: any) {
        req.log.error(err);
        return reply.code(500).send({ ok:false, error: err?.message ?? 'Internal error' });
    }
    });
    // 3) Penyesuaian stok (+/-) — tipe ADJUSTMENT
// Body:
// {
//   "productId": "uuid",
//   "locationCode": "GUDANG",
//   "uom": "gram",              // bebas, harga diri: akan masuk ledger apa adanya
//   "qty": -249915,             // bisa negatif (kurangi) atau positif (tambah)
//   "refId": "ADJ-0001"
// }
    app.post('/stock/adjust', async (req, reply) => {
    const schema = z.object({
        productId: z.string().uuid(),
        locationCode: z.string().min(1),
        uom: z.string().min(1),
        qty: z.number().refine((v)=> v !== 0, "qty tidak boleh 0"),
        refId: z.string().optional()
    });

    const p = schema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });

    const { productId, locationCode, uom, qty, refId } = p.data;

    const loc = await prisma.location.findUnique({ where: { code: locationCode } });
    if (!loc) return reply.code(404).send({ ok:false, error: 'Lokasi tidak ditemukan' });

    const uomOk = await prisma.productUom.findFirst({ where: { productId, uom } });
    if (!uomOk) return reply.code(400).send({ ok:false, error: `UOM ${uom} belum terdaftar pada produk` });

    const move = await prisma.stockMove.create({
        data: {
        productId,
        locationId: loc.id,
        qty,         // boleh negatif atau positif
        uom,
        type: 'ADJUSTMENT',
        refId: refId ?? null
        }
    });

    return reply.send({ ok:true, data: move });
    });

    // GET /stock/balance-by-uom?productId=...&locationCode=...
    app.get('/stock/balance-by-uom',  { preHandler: [requireRoles(app, ['admin','petugas_gudang'])] }, async (req, reply) => {
    try {
        const q = req.query as any;
        const productId = String(q.productId ?? '');
        const locationCode = String(q.locationCode ?? '');
        if (!productId || !locationCode) {
        return reply.code(400).send({ ok:false, error:'productId & locationCode wajib' });
        }
        const loc = await prisma.location.findUnique({ where: { code: locationCode } });
        if (!loc) return reply.code(404).send({ ok:false, error:`Lokasi tidak ditemukan: ${locationCode}` });

        // Jumlahkan qty APA ADANYA per UOM (tanpa konversi ke base)
        const rows = await prisma.stockMove.groupBy({
        by: ['uom'],
        where: { productId, locationId: loc.id },
        _sum: { qty: true }
        });

        // hasil: [{uom, qty}] dengan qty asli per-uom
        const data = rows.map(r => ({ uom: r.uom, qty: Number(r._sum.qty ?? 0) }));

        return reply.send({ ok:true, productId, locationCode, data });
    } catch (err:any) {
        req.log.error(err);
        return reply.code(500).send({ ok:false, error: err?.message ?? 'Internal error' });
    }
    });
}


