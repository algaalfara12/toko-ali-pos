// scripts/seed.cjs
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const prisma = new PrismaClient();

// helper Decimal aman (SQLite)
const D = (v) => String(v);

async function hash(pw) {
  return bcrypt.hash(pw, 10);
}

async function run() {
  console.log("=== SEED START (JS) ===");

  // Lokasi
  const gudang = await prisma.location.upsert({
    where: { code: "GUDANG" },
    update: {},
    create: { code: "GUDANG", name: "Gudang Utama" },
  });
  const etalase = await prisma.location.upsert({
    where: { code: "ETALASE" },
    update: {},
    create: { code: "ETALASE", name: "Etalase Toko" },
  });
  console.log("OK lokasi:", { GUDANG: gudang.id, ETALASE: etalase.id });

  // Users
  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      password: await hash("admin123"),
      role: "admin",
    },
  });
  const kasir = await prisma.user.upsert({
    where: { username: "kasir" },
    update: {},
    create: {
      username: "kasir",
      password: await hash("kasir123"),
      role: "kasir",
    },
  });
  const gudangUser = await prisma.user.upsert({
    where: { username: "gudang" },
    update: {},
    create: {
      username: "gudang",
      password: await hash("gudang123"),
      role: "petugas_gudang",
    },
  });
  console.log("OK users:", {
    admin: admin.id,
    kasir: kasir.id,
    gudang: gudangUser.id,
  });

  // Produk + UOM + Pricelist
  const gula = await prisma.product.upsert({
    where: { sku: "GULA001" },
    update: {},
    create: {
      sku: "GULA001",
      name: "Gula Pasir 1kg",
      baseUom: "gram",
      uoms: {
        create: [
          { uom: "1kg", toBase: 1000 },
          { uom: "500g", toBase: 500 },
        ],
      },
      prices: { create: [{ uom: "1kg", price: D(15000) }] },
    },
  });
  const kopi = await prisma.product.upsert({
    where: { sku: "KOPI001" },
    update: {},
    create: {
      sku: "KOPI001",
      name: "Kopi Bubuk 250g",
      baseUom: "gram",
      uoms: { create: [{ uom: "250g", toBase: 250 }] },
      prices: { create: [{ uom: "250g", price: D(12000) }] },
    },
  });
  console.log("OK products:", { GULA001: gula.id, KOPI001: kopi.id });

  // Tambah UOM dasar 'gram' (toBase=1) untuk kedua produk (agar balance & move 'gram' valid)
  await prisma.productUom.upsert({
    where: { productId_uom: { productId: gula.id, uom: "gram" } },
    update: { toBase: 1 },
    create: { productId: gula.id, uom: "gram", toBase: 1 },
  });
  await prisma.productUom.upsert({
    where: { productId_uom: { productId: kopi.id, uom: "gram" } },
    update: { toBase: 1 },
    create: { productId: kopi.id, uom: "gram", toBase: 1 },
  });
  console.log("OK uom dasar (gram): set toBase=1 untuk GULA & KOPI");

  // Stok awal (IN ke GUDANG) — idempotent via refId
  const SEED_REF = "SEED-IN-GUDANG-1";
  await prisma.stockMove.deleteMany({ where: { refId: SEED_REF } });
  await prisma.stockMove.createMany({
    data: [
      {
        productId: gula.id,
        locationId: gudang.id,
        qty: D(10000),
        uom: "gram",
        type: "IN",
        refId: SEED_REF,
      }, // 10kg
      {
        productId: kopi.id,
        locationId: gudang.id,
        qty: D(5000),
        uom: "gram",
        type: "IN",
        refId: SEED_REF,
      }, // 5kg
    ],
  });
  console.log("OK stok awal (GUDANG) — inserted with refId:", SEED_REF);

  // Penjualan contoh
  const sale = await prisma.sale.upsert({
    where: { number: "TOKOAL-TEST-0001" },
    update: {},
    create: {
      number: "TOKOAL-TEST-0001",
      cashierId: kasir.id,
      method: "CASH",
      subtotal: D(27000),
      discount: D(0),
      tax: D(0),
      total: D(27000),
      paid: D(30000),
      change: D(3000),
      lines: {
        create: [
          {
            productId: gula.id,
            uom: "1kg",
            qty: D(1),
            price: D(15000),
            discount: D(0),
            subtotal: D(15000),
          },
          {
            productId: kopi.id,
            uom: "250g",
            qty: D(1),
            price: D(12000),
            discount: D(0),
            subtotal: D(12000),
          },
        ],
      },
      payments: {
        create: [
          { method: "CASH", amount: D(27000), kind: "SALE", ref: "TUNAI" },
        ],
      },
    },
  });
  console.log("OK sale:", sale.number);

  // Retur + Refund contoh (retur kopi 1 pcs ke ETALASE)
  const ret = await prisma.saleReturn.upsert({
    where: { number: "RTN-TEST-0001" },
    update: {},
    create: {
      number: "RTN-TEST-0001",
      saleId: sale.id,
      cashierId: kasir.id,
      locationId: etalase.id,
      reason: "Kopi rusak",
      subtotal: D(12000),
      lines: {
        create: [
          {
            productId: kopi.id,
            uom: "250g",
            qty: D(1),
            price: D(12000),
            subtotal: D(12000),
          },
        ],
      },
      payments: {
        create: [
          { method: "CASH", amount: D(12000), kind: "REFUND", ref: "RET-KOPI" },
        ],
      },
    },
  });
  await prisma.stockMove.create({
    data: {
      productId: kopi.id,
      locationId: etalase.id,
      qty: D(1),
      uom: "250g",
      type: "RETURN",
      refId: ret.id,
    },
  });
  console.log("OK sale return:", ret.number);

  console.log("=== SEED DONE (JS) ===");
}

run()
  .catch((e) => {
    console.error("FATAL seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
