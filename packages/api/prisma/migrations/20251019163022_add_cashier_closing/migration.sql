-- CreateTable
CREATE TABLE "CashierClosing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "cashierId" TEXT NOT NULL,
    "cashierUsername" TEXT NOT NULL,
    "salesCash" DECIMAL NOT NULL DEFAULT 0,
    "salesNonCash" DECIMAL NOT NULL DEFAULT 0,
    "salesAll" DECIMAL NOT NULL DEFAULT 0,
    "items" INTEGER NOT NULL DEFAULT 0,
    "refundCash" DECIMAL NOT NULL DEFAULT 0,
    "refundNonCash" DECIMAL NOT NULL DEFAULT 0,
    "refundAll" DECIMAL NOT NULL DEFAULT 0,
    "nettCash" DECIMAL NOT NULL DEFAULT 0,
    "nettNonCash" DECIMAL NOT NULL DEFAULT 0,
    "nettAll" DECIMAL NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CashierClosing_date_idx" ON "CashierClosing"("date");

-- CreateIndex
CREATE INDEX "CashierClosing_cashierId_idx" ON "CashierClosing"("cashierId");

-- CreateIndex
CREATE UNIQUE INDEX "CashierClosing_cashierId_date_key" ON "CashierClosing"("cashierId", "date");
