// packages/api/src/routes/purchaseOrders.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { buildPurchaseOrderPreviewPdf } from "../utils/pdf";

// Helper: load logo dari StoreProfile
async function loadBrand() {
  const sp = await prisma.storeProfile.findFirst();
  const brand = {
    storeName: sp?.name ?? "TOKO ALI POS",
    storeFooterNote: sp?.footerNote ?? undefined,
    logoUrl: sp?.logoUrl ?? undefined,
  };
  let storeLogoBuffer: Buffer | undefined;
  if (brand.logoUrl) {
    try {
      const r = await fetch(brand.logoUrl);
      if (r.ok) {
        const arr = await r.arrayBuffer();
        storeLogoBuffer = Buffer.from(arr);
      }
    } catch {}
  }
  return { ...brand, storeLogoBuffer };
}

// Parser tanggal yang toleran: ISO string atau YYYY-MM-DD
function parseExpectedDate(s?: string): Date | undefined {
  if (!s) return undefined;
  const d1 = new Date(s);
  if (!isNaN(d1.getTime())) return d1;
  // fallback YYYY-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]),
      mo = Number(m[2]) - 1,
      da = Number(m[3]);
    const d2 = new Date(y, mo, da, 0, 0, 0, 0);
    if (!isNaN(d2.getTime())) return d2;
  }
  return undefined;
}

export default async function purchaseOrdersRoutes(app: FastifyInstance) {
  // Admin only
  app.post(
    "/purchase-orders/preview",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const Body = z.object({
        supplier: z
          .object({
            name: z.string().optional(),
            phone: z.string().optional(),
            address: z.string().optional(),
          })
          .optional(),
        // longgarkan validasi -> boleh string apapun, nanti diparse
        expectedDate: z.string().optional(),
        note: z.string().optional(),
        lines: z
          .array(
            z.object({
              productId: z.string(),
              uom: z.string(),
              qty: z.coerce.number().positive(),
            })
          )
          .min(1, "lines minimal 1"),
        export: z.string().optional(), // 'pdf' (default)
      });

      const p = Body.safeParse(req.body);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }

      const { supplier, expectedDate, note, lines } = p.data;

      // Ambil info sku/nama produk untuk preview
      const productIds = Array.from(new Set(lines.map((l) => l.productId)));
      const prods = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, name: true },
      });
      const pmap = new Map<
        string,
        { sku?: string | null; name?: string | null }
      >();
      for (const pr of prods) pmap.set(pr.id, { sku: pr.sku, name: pr.name });

      const brand = await loadBrand();

      const expDate = parseExpectedDate(expectedDate); // bisa undefined
      const pdf = await buildPurchaseOrderPreviewPdf({
        storeName: brand.storeName,
        storeLogoBuffer: brand.storeLogoBuffer,
        storeFooterNote: brand.storeFooterNote,
        supplier: supplier ?? undefined,
        expectedDate: expDate, // Date | undefined
        note,
        lines: lines.map((l) => ({
          sku: pmap.get(l.productId)?.sku ?? null,
          name: pmap.get(l.productId)?.name ?? null,
          uom: l.uom,
          qty: Number(l.qty),
        })),
      });

      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `attachment; filename="po_preview.pdf"`
      );
      return reply.send(pdf);
    }
  );
}
