-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Payment_kind_saleId_idx" ON "Payment"("kind", "saleId");

-- CreateIndex
CREATE INDEX "Payment_kind_saleReturnId_idx" ON "Payment"("kind", "saleReturnId");

-- CreateIndex
CREATE INDEX "PriceList_productId_uom_active_idx" ON "PriceList"("productId", "uom", "active");

-- CreateIndex
CREATE INDEX "Sale_createdAt_cashierId_idx" ON "Sale"("createdAt", "cashierId");

-- CreateIndex
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");

-- CreateIndex
CREATE INDEX "SaleLine_productId_idx" ON "SaleLine"("productId");

-- CreateIndex
CREATE INDEX "SaleReturn_createdAt_cashierId_locationId_idx" ON "SaleReturn"("createdAt", "cashierId", "locationId");

-- CreateIndex
CREATE INDEX "StockMove_productId_locationId_createdAt_idx" ON "StockMove"("productId", "locationId", "createdAt");
