-- CreateTable
CREATE TABLE "Tombstone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resource" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Tombstone_deletedAt_idx" ON "Tombstone"("deletedAt");

-- CreateIndex
CREATE INDEX "Tombstone_updatedAt_idx" ON "Tombstone"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Tombstone_resource_entityId_key" ON "Tombstone"("resource", "entityId");
