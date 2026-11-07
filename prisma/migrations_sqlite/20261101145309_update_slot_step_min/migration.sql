-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "phone" TEXT,
    "whatsapp" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "instagram" TEXT,
    "description" TEXT,
    "logoUrl" TEXT,
    "coverUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#d4a24e',
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "slotStepMin" INTEGER NOT NULL DEFAULT 30,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Organization" ("address", "city", "coverUrl", "createdAt", "description", "id", "instagram", "logoUrl", "name", "phone", "primaryColor", "settings", "slotStepMin", "slug", "state", "status", "timezone", "updatedAt", "whatsapp") SELECT "address", "city", "coverUrl", "createdAt", "description", "id", "instagram", "logoUrl", "name", "phone", "primaryColor", "settings", "slotStepMin", "slug", "state", "status", "timezone", "updatedAt", "whatsapp" FROM "Organization";
DROP TABLE "Organization";
ALTER TABLE "new_Organization" RENAME TO "Organization";
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_status_idx" ON "Organization"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
