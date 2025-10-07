-- DropIndex
DROP INDEX "Payment_saleId_idx";

-- DropIndex
DROP INDEX "SaleLine_productId_idx";

-- DropIndex
DROP INDEX "SaleLine_saleId_idx";

-- CreateTable
CREATE TABLE "Repack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "notes" TEXT,
    "extraCost" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RepackInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repackId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    CONSTRAINT "RepackInput_repackId_fkey" FOREIGN KEY ("repackId") REFERENCES "Repack" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RepackInput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepackOutput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repackId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "hpp" DECIMAL NOT NULL DEFAULT 0,
    CONSTRAINT "RepackOutput_repackId_fkey" FOREIGN KEY ("repackId") REFERENCES "Repack" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RepackOutput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "customerId" TEXT,
    "method" TEXT NOT NULL,
    "subtotal" DECIMAL NOT NULL,
    "discount" DECIMAL NOT NULL DEFAULT 0,
    "tax" DECIMAL NOT NULL DEFAULT 0,
    "total" DECIMAL NOT NULL,
    "paid" DECIMAL NOT NULL,
    "change" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sale_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Sale" ("cashierId", "change", "createdAt", "customerId", "discount", "id", "method", "number", "paid", "subtotal", "tax", "total", "updatedAt") SELECT "cashierId", "change", "createdAt", "customerId", "discount", "id", "method", "number", "paid", "subtotal", "tax", "total", "updatedAt" FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
CREATE UNIQUE INDEX "Sale_number_key" ON "Sale"("number");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Repack_number_key" ON "Repack"("number");
