// packages/api/src/routes/repack.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { audit } from "../utils/audit";
import { buildRepackReportPdf } from "../utils/pdf"; // fungsi builder di atas

// konversi qty dari uom → base (pakai ProductUom.toBase)
async function toBaseQty(productId: string, uom: string, qty: number) {
  const u = await prisma.productUom.findFirst({ where: { productId, uom } });
  if (!u) throw new Error(`UOM ${uom} belum terdaftar untuk produk`);
  return Number(u.toBase) * qty;
}

function nextRepackNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  // simple sequence by timestamp
  return `RPK-${y}${m}${dd}-${Date.now().toString().slice(-6)}`;
}

// helper: load storeBrand (logo, footer, tz)
async function loadStoreBrand() {
  const sp = await prisma.storeProfile.findFirst();
  let storeLogoBuffer: Buffer | undefined;
  if (sp?.logoUrl) {
    try {
      const r = await fetch(sp.logoUrl);
      if (r.ok) {
        const arr = await r.arrayBuffer();
        storeLogoBuffer = Buffer.from(arr);
      }
    } catch {}
  }
  return {
    storeName: sp?.name ?? "TOKO ALI POS",
    storeFooterNote: sp?.footerNote ?? undefined,
    storeLogoBuffer,
    timezone: sp?.timezone || "Asia/Jakarta",
  };
}

// helper: format local datetime label sesuai TZ toko
function toLocalLabel(d: Date, tz: string) {
  try {
    const parts = new Intl.DateTimeFormat("id-ID", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
      "minute"
    )}`;
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

export default async function repackRoutes(app: FastifyInstance) {
  // CREATE REPACK
  app.post(
    "/repack",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const b = req.body as any;
      try {
        const inputs = Array.isArray(b.inputs) ? b.inputs : [];
        const outputs = Array.isArray(b.outputs) ? b.outputs : [];
        const notes = b.notes ? String(b.notes) : null;
        const extraCost = Number(b.extraCost ?? 0);

        if (inputs.length === 0 || outputs.length === 0) {
          return reply.code(400).send({
            ok: false,
            error: "inputs dan outputs tidak boleh kosong",
          });
        }

        // Validasi produk & UOM ada
        for (const inp of inputs) {
          const ok = await prisma.productUom.findFirst({
            where: { productId: String(inp.productId), uom: String(inp.uom) },
          });
          if (!ok)
            return reply.code(400).send({
              ok: false,
              error: `UOM ${inp.uom} belum terdaftar pada produk input`,
            });
        }
        for (const out of outputs) {
          const ok = await prisma.productUom.findFirst({
            where: { productId: String(out.productId), uom: String(out.uom) },
          });
          if (!ok)
            return reply.code(400).send({
              ok: false,
              error: `UOM ${out.uom} belum terdaftar pada produk output`,
            });
        }

        // Hitung total base qty (opsional validasi)
        let totalOutBase = 0;
        for (const o of outputs)
          totalOutBase += await toBaseQty(
            String(o.productId),
            String(o.uom),
            Number(o.qty)
          );
        if (totalOutBase <= 0) {
          return reply
            .code(400)
            .send({ ok: false, error: "Total output tidak valid" });
        }

        const number = nextRepackNumber();

        const data = await prisma.$transaction(async (tx) => {
          const repack = await tx.repack.create({
            data: { number, notes: notes ?? undefined, extraCost },
          });

          // default lokasi proses: GUDANG
          const gudang = await tx.location.findFirst({
            where: { code: "GUDANG" },
          });
          if (!gudang) throw new Error("Lokasi GUDANG tidak ditemukan");

          for (const i of inputs) {
            const productId = String(i.productId);
            const uom = String(i.uom);
            const qty = Number(i.qty);
            await tx.repackInput.create({
              data: { repackId: repack.id, productId, uom, qty },
            });
            await tx.stockMove.create({
              data: {
                productId,
                locationId: gudang.id,
                qty: -qty,
                uom,
                type: "REPACK_OUT",
                refId: repack.id,
              },
            });
          }

          // Simpan detail output + stock move REPACK_IN (qty positif)
          for (const o of outputs) {
            const productId = String(o.productId);
            const uom = String(o.uom);
            const qty = Number(o.qty);
            await tx.repackOutput.create({
              data: { repackId: repack.id, productId, uom, qty, hpp: 0 },
            });
            await tx.stockMove.create({
              data: {
                productId,
                locationId: gudang.id,
                qty,
                uom,
                type: "REPACK_IN",
                refId: repack.id,
              },
            });
          }
          return repack;
        });

        // AUDIT => untuk tahu usernya saat report
        await audit(req, {
          action: "REPACK",
          entityType: "REPACK",
          entityId: data.id,
          refNumber: number,
          payload: {
            inputsCount: inputs.length,
            outputsCount: outputs.length,
            notes,
            extraCost,
          },
        });

        return reply.send({ ok: true, data });
      } catch (err: any) {
        req.log.error(err);
        return reply
          .code(500)
          .send({ ok: false, error: err?.message ?? "Internal error" });
      }
    }
  );

  // DETAIL REPACK
  app.get(
    "/repack/:id",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const { id } = req.params as any;
      const repack = await prisma.repack.findUnique({
        where: { id },
        include: {
          inputs: {
            include: { product: { select: { sku: true, name: true } } },
          },
          outputs: {
            include: { product: { select: { sku: true, name: true } } },
          },
        },
      });
      if (!repack)
        return reply
          .code(404)
          .send({ ok: false, error: "Repack tidak ditemukan" });
      return reply.send({ ok: true, data: repack });
    }
  );

  // REPORT PDF (All-Time / Filter)
  app.get(
    "/repack/report",
    { preHandler: [requireRoles(app, ["admin", "petugas_gudang"])] },
    async (req, reply) => {
      const q = req.query as any;
      const startStr = q.start ? String(q.start) : null; // YYYY-MM-DD
      const endStr = q.end ? String(q.end) : null;

      let createdAtFilter: any = {};
      let periodLabel = "All Time";
      if (startStr && endStr) {
        const start = new Date(`${startStr}T00:00:00.000Z`);
        const end = new Date(`${endStr}T23:59:59.999Z`);
        createdAtFilter = { gte: start, lte: end };
        periodLabel = `${startStr} s.d. ${endStr}`;
      } else if (startStr) {
        const start = new Date(`${startStr}T00:00:00.000Z`);
        createdAtFilter = { gte: start };
        periodLabel = `≥ ${startStr}`;
      } else if (endStr) {
        const end = new Date(`${endStr}T23:59:59.999Z`);
        createdAtFilter = { lte: end };
        periodLabel = `≤ ${endStr}`;
      }

      // load brand
      const brand = await loadStoreBrand();
      const tz = brand.timezone || "Asia/Jakarta";

      // ambil repack (berikut input & output + product.sku/name)
      const repacks = await prisma.repack.findMany({
        where: Object.keys(createdAtFilter).length
          ? { createdAt: createdAtFilter }
          : undefined,
        orderBy: { createdAt: "asc" },
        include: {
          inputs: {
            include: { product: { select: { sku: true, name: true } } },
          },
          outputs: {
            include: { product: { select: { sku: true, name: true } } },
          },
        },
      });

      // ambil audit untuk mengambil userName (actorUsername) per repack
      const ids = repacks.map((r) => r.id);
      const audits = ids.length
        ? await prisma.auditLog.findMany({
            where: { entityType: "REPACK", entityId: { in: ids } },
            orderBy: { createdAt: "desc" },
            select: { entityId: true, actorUsername: true },
          })
        : [];
      const actorByEntity = new Map<string, string>();
      for (const a of audits) {
        if (!actorByEntity.has(a.entityId)) {
          actorByEntity.set(a.entityId, a.actorUsername ?? "-");
        }
      }

      // bangun rows pdf
      const rows = repacks.map((r) => ({
        number: r.number,
        createdAt: r.createdAt,
        createdAtLabel: toLocalLabel(r.createdAt, tz),
        userName: actorByEntity.get(r.id) ?? "-", // fallback
        notes: r.notes ?? null,
        extraCost: r.extraCost != null ? Number(r.extraCost) : null,
        inputs: (r.inputs || []).map((i) => ({
          sku: i.product?.sku ?? null,
          name: i.product?.name ?? "",
          uom: i.uom,
          qty: Number(i.qty),
        })),
        outputs: (r.outputs || []).map((o) => ({
          sku: o.product?.sku ?? null,
          name: o.product?.name ?? "",
          uom: o.uom,
          qty: Number(o.qty),
        })),
      }));

      const pdf = await buildRepackReportPdf({
        storeName: brand.storeName,
        periodLabel,
        storeLogoBuffer: brand.storeLogoBuffer,
        storeFooterNote: brand.storeFooterNote,
        rows,
      });

      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="repack_report_${periodLabel.replace(
          /\s+/g,
          "_"
        )}.pdf"`
      );
      return reply.send(pdf);
    }
  );
}
