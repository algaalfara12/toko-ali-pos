/*
  Warnings:

  - Added the required column `updatedAt` to the `Barcode` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Product" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "Product" ADD COLUMN "lastModifiedById" TEXT;

-- CreateTable
CREATE TABLE "SyncClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "since" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncCheckpoint_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "SyncClient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Barcode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "lastModifiedById" TEXT,
    CONSTRAINT "Barcode_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Barcode" ("code", "id", "productId", "uom") SELECT "code", "id", "productId", "uom" FROM "Barcode";
DROP TABLE "Barcode";
ALTER TABLE "new_Barcode" RENAME TO "Barcode";
CREATE UNIQUE INDEX "Barcode_code_key" ON "Barcode"("code");
CREATE INDEX "Barcode_updatedAt_idx" ON "Barcode"("updatedAt");
CREATE UNIQUE INDEX "Barcode_productId_uom_key" ON "Barcode"("productId", "uom");
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "memberCode" TEXT,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "lastModifiedById" TEXT
);
INSERT INTO "new_Customer" ("email", "id", "isActive", "joinedAt", "memberCode", "name", "phone") SELECT "email", "id", "isActive", "joinedAt", "memberCode", "name", "phone" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");
CREATE UNIQUE INDEX "Customer_memberCode_key" ON "Customer"("memberCode");
CREATE INDEX "Customer_updatedAt_idx" ON "Customer"("updatedAt");
CREATE TABLE "new_Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "lastModifiedById" TEXT
);
INSERT INTO "new_Location" ("code", "id", "name") SELECT "code", "id", "name" FROM "Location";
DROP TABLE "Location";
ALTER TABLE "new_Location" RENAME TO "Location";
CREATE UNIQUE INDEX "Location_code_key" ON "Location"("code");
CREATE INDEX "Location_updatedAt_idx" ON "Location"("updatedAt");
CREATE TABLE "new_PriceList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "lastModifiedById" TEXT,
    CONSTRAINT "PriceList_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PriceList" ("active", "id", "price", "productId", "uom") SELECT "active", "id", "price", "productId", "uom" FROM "PriceList";
DROP TABLE "PriceList";
ALTER TABLE "new_PriceList" RENAME TO "PriceList";
CREATE INDEX "PriceList_productId_idx" ON "PriceList"("productId");
CREATE INDEX "PriceList_productId_uom_active_idx" ON "PriceList"("productId", "uom", "active");
CREATE INDEX "PriceList_updatedAt_idx" ON "PriceList"("updatedAt");
CREATE TABLE "new_ProductUom" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "toBase" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "lastModifiedById" TEXT,
    CONSTRAINT "ProductUom_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ProductUom" ("id", "productId", "toBase", "uom") SELECT "id", "productId", "toBase", "uom" FROM "ProductUom";
DROP TABLE "ProductUom";
ALTER TABLE "new_ProductUom" RENAME TO "ProductUom";
CREATE INDEX "ProductUom_updatedAt_idx" ON "ProductUom"("updatedAt");
CREATE UNIQUE INDEX "ProductUom_productId_uom_key" ON "ProductUom"("productId", "uom");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SyncClient_deviceId_key" ON "SyncClient"("deviceId");

-- CreateIndex
CREATE INDEX "SyncCheckpoint_updatedAt_idx" ON "SyncCheckpoint"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncCheckpoint_clientId_resource_key" ON "SyncCheckpoint"("clientId", "resource");

-- CreateIndex
CREATE INDEX "Product_updatedAt_idx" ON "Product"("updatedAt");
