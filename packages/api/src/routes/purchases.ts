import { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { requireRoles } from "../utils/roleGuard";
import { audit } from "../utils/audit";
import { buildPurchaseSlipPdf } from "../utils/pdf";

// Helper nomor: PO-YYYYMMDD-XXXX (sequence per hari)
async function nextPurchaseNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const dateTag = `${y}${m}${day}`;

  const start = new Date(y, d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const end = new Date(y, d.getMonth(), d.getDate(), 23, 59, 59, 999);

  const countToday = await prisma.purchase.count({
    where: { createdAt: { gte: start, lte: end } },
  });
  const running = String(countToday + 1).padStart(4, "0");
  return `PO-${dateTag}-${running}`;
}

async function loadStoreBrandWithTz() {
  const sp = await prisma.storeProfile.findFirst();
  const brand = {
    storeName: sp?.name ?? "TOKO ALI POS",
    storeAddress: sp?.address ?? undefined,
    storePhone: sp?.phone ?? undefined,
    storeFooterNote: sp?.footerNote ?? undefined,
    logoUrl: sp?.logoUrl ?? undefined,
    timezone: sp?.timezone ?? "Asia/Jakarta",
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

export default async function purchasesRoutes(app: FastifyInstance) {
  // POST /purchases
  app.post(
    "/purchases",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      try {
        const b = req.body as any;

        if (!b?.locationCode) {
          return reply
            .code(400)
            .send({ ok: false, error: "locationCode wajib" });
        }
        if (!Array.isArray(b?.lines) || b.lines.length === 0) {
          return reply
            .code(400)
            .send({ ok: false, error: "lines wajib dan tidak boleh kosong" });
        }

        const loc = await prisma.location.findUnique({
          where: { code: String(b.locationCode) },
        });
        if (!loc)
          return reply.code(400).send({
            ok: false,
            error: `Lokasi tidak ditemukan: ${b.locationCode}`,
          });

        let supplierId: string | null = null;
        if (b.supplierId) {
          supplierId = String(b.supplierId);
        } else if (b.supplier?.name) {
          const name = String(b.supplier.name);
          const phone = b.supplier.phone ? String(b.supplier.phone) : undefined;
          const address = b.supplier.address
            ? String(b.supplier.address)
            : undefined;

          if (phone) {
            const sup = await prisma.supplier.upsert({
              where: { phone },
              create: { name, phone, address },
              update: { name, address },
            });
            supplierId = sup.id;
          } else {
            const sup = await prisma.supplier.create({
              data: { name, phone: null, address },
            });
            supplierId = sup.id;
          }
        }

        let subtotal = 0;
        for (const l of b.lines) {
          const qty = Number(l.qty);
          const buy = Number(l.buyPrice);
          if (!(qty > 0) || !(buy >= 0)) {
            return reply.code(400).send({
              ok: false,
              error: "qty harus > 0 & buyPrice >= 0 pada setiap baris",
            });
          }
          subtotal += qty * buy;
        }
        const discount = Number(b.discount ?? 0);
        const total = subtotal - discount;

        const number = await nextPurchaseNumber();

        const result = await prisma.$transaction(async (tx) => {
          const header = await tx.purchase.create({
            data: {
              number,
              supplierId,
              locationId: loc.id,
              subtotal,
              discount,
              total,
            },
          });

          const createdLines: any[] = [];

          for (const l of b.lines) {
            const productId = String(l.productId);
            const uom = String(l.uom);
            const qty = Number(l.qty);
            const buyPrice = Number(l.buyPrice);
            const sellPrice = l.sellPrice != null ? Number(l.sellPrice) : null;

            const uomMap = await tx.productUom.findFirst({
              where: { productId, uom },
            });
            if (!uomMap) {
              throw new Error(
                `UOM ${uom} belum terdaftar untuk produk ${productId}`
              );
            }

            const line = await tx.purchaseLine.create({
              data: {
                purchaseId: header.id,
                productId,
                uom,
                qty,
                buyPrice,
                sellPrice,
                subtotal: qty * buyPrice,
              },
            });
            createdLines.push(line);

            await tx.stockMove.create({
              data: {
                productId,
                locationId: loc.id,
                qty, // IN = positif
                uom,
                type: "IN",
                refId: header.id,
              },
            });

            if (sellPrice != null) {
              const existing = await tx.priceList.findFirst({
                where: { productId, uom, active: true },
              });
              if (existing) {
                await tx.priceList.update({
                  where: { id: existing.id },
                  data: { price: sellPrice },
                });
              } else {
                await tx.priceList.create({
                  data: { productId, uom, price: sellPrice, active: true },
                });
              }
            }
          }

          return { header, lines: createdLines };
        });

        // === AUDIT: PURCHASE ===
        try {
          await audit(req, {
            action: "PURCHASE",
            entityType: "PURCHASE",
            entityId: result.header.id,
            refNumber: result.header.number,
            payload: {
              supplier: b.supplier
                ? {
                    name: b.supplier.name,
                    phone: b.supplier.phone ?? null,
                    address: b.supplier.address ?? null,
                  }
                : { supplierId }, // kalau pakai supplierId saja, phone memang tidak ada
              locationCode: b.locationCode,
              subtotal,
              discount,
              total,
              lines: (result.lines ?? []).map((l: any) => ({
                productId: l.productId,
                uom: l.uom,
                qty: Number(l.qty),
                buyPrice: Number(l.buyPrice),
                sellPrice: l.sellPrice != null ? Number(l.sellPrice) : null,
                subtotal: Number(l.subtotal),
              })),
            },
          });
        } catch (e) {
          req.log.warn({ e }, "audit purchase failed (non-blocking)");
        }

        return reply.send({ ok: true, data: result });
      } catch (err: any) {
        req.log.error(err);
        return reply
          .code(500)
          .send({ ok: false, error: err?.message ?? "Internal error" });
      }
    }
  );

  // GET /purchases (list)
  app.get(
    "/purchases",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const q = req.query as any;
      const page = Math.max(1, Number(q.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 20)));

      let createdAtFilter: any = undefined;
      if (q.date) {
        const d = new Date(String(q.date));
        const start = new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
          0,
          0,
          0,
          0
        );
        const end = new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
          23,
          59,
          59,
          999
        );
        createdAtFilter = { gte: start, lte: end };
      }

      let locationId: string | undefined;
      if (q.locationCode) {
        const loc = await prisma.location.findUnique({
          where: { code: String(q.locationCode) },
        });
        if (!loc)
          return reply.code(400).send({
            ok: false,
            error: `Lokasi tidak ditemukan: ${q.locationCode}`,
          });
        locationId = loc.id;
      }

      const baseWhere: any = {
        ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
        ...(locationId ? { locationId } : {}),
        ...(q.supplierId ? { supplierId: String(q.supplierId) } : {}),
      };

      const rowsRaw = await prisma.purchase.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
        take: 500,
        include: {
          supplier: true,
          location: true,
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
        },
      });

      const keyword = (q.q ? String(q.q).trim() : "").toLowerCase();
      let rowsFiltered = rowsRaw;
      if (keyword) {
        rowsFiltered = rowsRaw.filter((p) => {
          const inHeader =
            (p.number ?? "").toLowerCase().includes(keyword) ||
            (p.supplier?.name ?? "").toLowerCase().includes(keyword);
          const inLines = p.lines?.some(
            (l) =>
              (l.product?.sku ?? "").toLowerCase().includes(keyword) ||
              (l.product?.name ?? "").toLowerCase().includes(keyword)
          );
          return inHeader || inLines;
        });
      }

      const total = rowsFiltered.length;
      const startIdx = (page - 1) * pageSize;
      const pageData = rowsFiltered.slice(startIdx, startIdx + pageSize);

      return reply.send({
        ok: true,
        page,
        pageSize,
        total,
        data: pageData.map((p) => ({
          id: p.id,
          number: p.number,
          createdAt: p.createdAt,
          supplier: p.supplier
            ? {
                id: p.supplier.id,
                name: p.supplier.name,
                phone: p.supplier.phone,
              }
            : null,
          location: p.location
            ? { code: p.location.code, name: p.location.name }
            : null,
          subtotal: Number(p.subtotal),
          discount: Number(p.discount),
          total: Number(p.total),
          lines: p.lines.map((l) => ({
            id: l.id,
            productId: l.productId,
            sku: l.product.sku,
            name: l.product.name,
            uom: l.uom,
            qty: Number(l.qty),
            buyPrice: Number(l.buyPrice),
            sellPrice: l.sellPrice != null ? Number(l.sellPrice) : null,
            subtotal: Number(l.subtotal),
          })),
        })),
      });
    }
  );

  // GET /purchases/:id
  app.get(
    "/purchases/:id",
    { preHandler: [requireRoles(app, ["admin"])] },
    async (req, reply) => {
      const { id } = req.params as any;
      const q = req.query as any;
      const exportFmt = (q.export ?? "").toLowerCase();

      const p = await prisma.purchase.findUnique({
        where: { id: String(id) },
        include: {
          supplier: true,
          location: true,
          lines: {
            include: { product: { select: { sku: true, name: true } } },
          },
        },
      });
      if (!p)
        return reply
          .code(404)
          .send({ ok: false, error: "Purchase tidak ditemukan" });

      if (exportFmt === "pdf") {
        // load brand/logo
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
        const pdf = await buildPurchaseSlipPdf({
          storeName: sp?.name ?? "TOKO ALI POS",
          storeLogoBuffer,
          storeAddress: sp?.address ?? undefined,
          storePhone: sp?.phone ?? undefined,
          storeFooterNote: sp?.footerNote ?? undefined,

          number: p.number,
          createdAt: p.createdAt,
          supplier: p.supplier
            ? {
                name: p.supplier.name,
                phone: p.supplier.phone,
                address: p.supplier.address ?? undefined,
              }
            : undefined,
          location: p.location
            ? { code: p.location.code, name: p.location.name }
            : undefined,
          note: null,

          lines: p.lines.map((l) => ({
            sku: l.product?.sku ?? null,
            name: l.product?.name ?? null,
            uom: l.uom,
            qty: Number(l.qty),
            buyPrice: Number(l.buyPrice),
            sellPrice: l.sellPrice != null ? Number(l.sellPrice) : null,
            subtotal: Number(l.subtotal),
          })),
          subtotal: Number(p.subtotal),
          discount: Number(p.discount),
          total: Number(p.total),
        });

        reply.header("Content-Type", "application/pdf");
        reply.header(
          "Content-Disposition",
          `attachment; filename="purchase_${p.number}.pdf"`
        );
        return reply.send(pdf);
      }

      // JSON default (tetap seperti semula)
      return reply.send({
        ok: true,
        data: {
          id: p.id,
          number: p.number,
          createdAt: p.createdAt,
          supplier: p.supplier
            ? {
                id: p.supplier.id,
                name: p.supplier.name,
                phone: p.supplier.phone,
              }
            : null,
          location: p.location
            ? { code: p.location.code, name: p.location.name }
            : null,
          subtotal: Number(p.subtotal),
          discount: Number(p.discount),
          total: Number(p.total),
          lines: p.lines.map((l) => ({
            id: l.id,
            productId: l.productId,
            sku: l.product?.sku,
            name: l.product?.name,
            uom: l.uom,
            qty: Number(l.qty),
            buyPrice: Number(l.buyPrice),
            sellPrice: l.sellPrice != null ? Number(l.sellPrice) : null,
            subtotal: Number(l.subtotal),
          })),
        },
      });
    }
  );
}
