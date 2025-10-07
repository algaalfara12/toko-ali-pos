import { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';

// konversi qty dari uom → base (pakai ProductUom.toBase)
async function toBaseQty(productId: string, uom: string, qty: number) {
  const u = await prisma.productUom.findFirst({ where: { productId, uom } });
  if (!u) throw new Error(`UOM ${uom} belum terdaftar untuk produk`);
  return Number(u.toBase) * qty;
}

function nextRepackNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  // simple sequence by timestamp
  return `RPK-${y}${m}${dd}-${Date.now().toString().slice(-6)}`;
}

/**
 * POST /repack
 * {
 *   "notes": "pecah 1 karung ke bungkus",
 *   "extraCost": 0,
 *   "inputs":  [ { "productId": "...", "uom": "karung_50kg", "qty": 1 } ],
 *   "outputs": [ { "productId": "...", "uom": "bungkus_500g", "qty": 100 } ]
 * }
 */
export default async function repackRoutes(app: FastifyInstance) {
  app.post('/repack', async (req, reply) => {
    const b = req.body as any;
    try {
      const inputs  = Array.isArray(b.inputs)  ? b.inputs  : [];
      const outputs = Array.isArray(b.outputs) ? b.outputs : [];
      const notes   = b.notes ? String(b.notes) : null;
      const extraCost = Number(b.extraCost ?? 0);

      if (inputs.length === 0 || outputs.length === 0) {
        return reply.code(400).send({ ok:false, error: 'inputs dan outputs tidak boleh kosong' });
      }

      // Validasi produk & UOM ada
      for (const inp of inputs) {
        const ok = await prisma.productUom.findFirst({ where: { productId: String(inp.productId), uom: String(inp.uom) }});
        if (!ok) return reply.code(400).send({ ok:false, error: `UOM ${inp.uom} belum terdaftar pada produk input` });
      }
      for (const out of outputs) {
        const ok = await prisma.productUom.findFirst({ where: { productId: String(out.productId), uom: String(out.uom) }});
        if (!ok) return reply.code(400).send({ ok:false, error: `UOM ${out.uom} belum terdaftar pada produk output` });
      }

      // Hitung total base qty input & output (opsional validasi)
      let totalInBase = 0;
      for (const i of inputs) totalInBase += await toBaseQty(String(i.productId), String(i.uom), Number(i.qty));
      let totalOutBase = 0;
      for (const o of outputs) totalOutBase += await toBaseQty(String(o.productId), String(o.uom), Number(o.qty));

      if (totalOutBase <= 0) {
        return reply.code(400).send({ ok:false, error: 'Total output tidak valid' });
      }

      // hpp per base unit (sementara 0; nanti bisa dihitung dari saldo & extraCost)
      const hppPerBase = 0; // TODO: kembangkan average cost
      const number = nextRepackNumber();

      const data = await prisma.$transaction(async (tx) => {
        const repack = await tx.repack.create({
          data: { number, notes: notes ?? undefined, extraCost }
        });

        // Simpan detail input + stock move REPACK_OUT (qty negatif)
        for (const i of inputs) {
          const productId = String(i.productId);
          const uom = String(i.uom);
          const qty = Number(i.qty);
          await tx.repackInput.create({ data: { repackId: repack.id, productId, uom, qty } });
          await tx.stockMove.create({
            data: {
              productId,
              locationId: (await tx.location.findFirst({ where: { code: 'GUDANG' } }))!.id, // default dari GUDANG; nanti bisa dijadikan parameter
              qty: -qty,
              uom,
              type: 'REPACK_OUT',
              refId: repack.id
            }
          });
        }

        // Simpan detail output + stock move REPACK_IN (qty positif)
        for (const o of outputs) {
          const productId = String(o.productId);
          const uom = String(o.uom);
          const qty = Number(o.qty);

          // hpp output sementara = hppPerBase * (toBase qty)
          const outBase = await toBaseQty(productId, uom, qty);
          const hpp = hppPerBase * outBase;

          await tx.repackOutput.create({ data: { repackId: repack.id, productId, uom, qty, hpp } });
          await tx.stockMove.create({
            data: {
              productId,
              locationId: (await tx.location.findFirst({ where: { code: 'GUDANG' } }))!.id, // hasil masuk ke GUDANG; bisa diubah ke ETALASE jika mau
              qty: qty,
              uom,
              type: 'REPACK_IN',
              refId: repack.id
            }
          });
        }

        return repack;
      });

      return reply.send({ ok:true, data });
    } catch (err: any) {
      req.log.error(err);
      return reply.code(500).send({ ok:false, error: err?.message ?? 'Internal error' });
    }
  });

  // Lihat detail repack
  app.get('/repack/:id', async (req, reply) => {
    const { id } = req.params as any;
    const repack = await prisma.repack.findUnique({
      where: { id },
      include: { inputs: true, outputs: true }
    });
    if (!repack) return reply.code(404).send({ ok:false, error: 'Repack tidak ditemukan' });
    return reply.send({ ok:true, data: repack });
  });
}
