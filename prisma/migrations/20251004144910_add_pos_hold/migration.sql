-- CreateTable
CREATE TABLE "PosHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "cashierCode" TEXT NOT NULL,
    "customerId" TEXT,
    "method" TEXT NOT NULL,
    "discountTotal" DECIMAL NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL,
    "payments" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PosHold_number_key" ON "PosHold"("number");
