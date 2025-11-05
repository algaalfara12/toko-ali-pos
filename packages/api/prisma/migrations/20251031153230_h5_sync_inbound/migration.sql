-- CreateTable
CREATE TABLE "SyncInbound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "clientDocId" TEXT NOT NULL,
    "serverDocId" TEXT,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SyncInbound_createdAt_idx" ON "SyncInbound"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncInbound_clientId_resource_clientDocId_key" ON "SyncInbound"("clientId", "resource", "clientDocId");
