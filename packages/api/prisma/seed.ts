// packages/api/prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function ensurePrice(
  productId: string,
  uom: string,
  price: number,
  active = true
) {
  const exists = await prisma.priceList.findFirst({
    where: { productId, uom, active },
  });
  if (!exists) {
    await prisma.priceList.create({ data: { productId, uom, price, active } });
  }
}

async function ensureUom(productId: string, uom: string, toBase: number) {
  await prisma.productUom.upsert({
    where: { productId_uom: { productId, uom } },
    update: { toBase },
    create: { productId, uom, toBase },
  });
}

async function main() {
  console.log("== Seeding start ==");

  // 1) Users
  const [admin, kasir, gudang] = await Promise.all([
    prisma.user.upsert({
      where: { username: "admin" },
      update: {},
      create: {
        username: "admin",
        password: await bcrypt.hash("admin123", 10),
        role: "admin",
      },
    }),
    prisma.user.upsert({
      where: { username: "kasir" },
      update: {},
      create: {
        username: "kasir",
        password: await bcrypt.hash("kasir123", 10),
        role: "kasir",
      },
    }),
    prisma.user.upsert({
      where: { username: "gudang" },
      update: {},
      create: {
        username: "gudang",
        password: await bcrypt.hash("gudang123", 10),
        role: "petugas_gudang",
      },
    }),
  ]);
  console.log("Users:", {
    admin: admin.id,
    kasir: kasir.id,
    gudang: gudang.id,
  });

  // 2) Locations
  const [locGudang, locEtalase] = await Promise.all([
    prisma.location.upsert({
      where: { code: "GUDANG" },
      update: {},
      create: { code: "GUDANG", name: "Gudang Utama" },
    }),
    prisma.location.upsert({
      where: { code: "ETALASE" },
      update: {},
      create: { code: "ETALASE", name: "Etalase Toko" },
    }),
  ]);
  console.log("Locations:", { GUDANG: locGudang.id, ETALASE: locEtalase.id });

  // 3) Products + UOM + PriceList
  // Gula (baseUom = gram)
  const gula = await prisma.product.upsert({
    where: { sku: "GULA-1" },
    update: {},
    create: {
      sku: "GULA-1",
      name: "Gula Pasir",
      baseUom: "gram",
      isActive: true,
    },
  });
  await ensureUom(gula.id, "1kg", 1000);
  await ensureUom(gula.id, "250g", 250);
  await ensurePrice(gula.id, "1kg", 15000, true);
  await ensurePrice(gula.id, "250g", 4000, true);

  // Kopi (baseUom = gram)
  const kopi = await prisma.product.upsert({
    where: { sku: "KOPI-1" },
    update: {},
    create: {
      sku: "KOPI-1",
      name: "Kopi Bubuk",
      baseUom: "gram",
      isActive: true,
    },
  });
  await ensureUom(kopi.id, "1kg", 1000);
  await ensureUom(kopi.id, "250g", 250);
  await ensurePrice(kopi.id, "1kg", 120000, true);
  await ensurePrice(kopi.id, "250g", 30000, true);

  console.log("Products:", { gula: gula.id, kopi: kopi.id });

  // 4) Stock IN ke GUDANG (hanya kalau belum ada move dengan refId seeding)
  const existingIn = await prisma.stockMove.findFirst({
    where: { refId: "SEED-IN-1" },
  });
  if (!existingIn) {
    await prisma.stockMove.create({
      data: {
        productId: gula.id,
        locationId: locGudang.id,
        qty: 50,
        uom: "1kg",
        type: "IN",
        refId: "SEED-IN-1",
      },
    });
  }
  const existingIn2 = await prisma.stockMove.findFirst({
    where: { refId: "SEED-IN-2" },
  });
  if (!existingIn2) {
    await prisma.stockMove.create({
      data: {
        productId: kopi.id,
        locationId: locGudang.id,
        qty: 30,
        uom: "1kg",
        type: "IN",
        refId: "SEED-IN-2",
      },
    });
  }

  // 5) Transfer sebagian ke ETALASE (idempotent by refId)
  const existingTf1 = await prisma.stockMove.findFirst({
    where: { refId: "SEED-TF-1", productId: gula.id },
  });
  if (!existingTf1) {
    await prisma.stockMove.create({
      data: {
        productId: gula.id,
        locationId: locGudang.id,
        qty: -10,
        uom: "1kg",
        type: "TRANSFER",
        refId: "SEED-TF-1",
      },
    });
    await prisma.stockMove.create({
      data: {
        productId: gula.id,
        locationId: locEtalase.id,
        qty: +10,
        uom: "1kg",
        type: "TRANSFER",
        refId: "SEED-TF-1",
      },
    });
  }
  const existingTf2 = await prisma.stockMove.findFirst({
    where: { refId: "SEED-TF-2", productId: kopi.id },
  });
  if (!existingTf2) {
    await prisma.stockMove.create({
      data: {
        productId: kopi.id,
        locationId: locGudang.id,
        qty: -20,
        uom: "250g",
        type: "TRANSFER",
        refId: "SEED-TF-2",
      },
    });
    await prisma.stockMove.create({
      data: {
        productId: kopi.id,
        locationId: locEtalase.id,
        qty: +20,
        uom: "250g",
        type: "TRANSFER",
        refId: "SEED-TF-2",
      },
    });
  }

  // 6) Customer contoh
  await prisma.customer.upsert({
    where: { phone: "08123" },
    update: {},
    create: {
      name: "Customer Uji",
      phone: "08123",
      email: "uji@example.com",
      memberCode: "MEMTEST1",
      isActive: true,
    },
  });

  console.log("== Seeding done ==");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
