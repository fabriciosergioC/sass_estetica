-- AlterTable
ALTER TABLE "WhatsAppMessage" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WhatsAppMessage_orgId_lastAttemptAt_idx" ON "WhatsAppMessage"("orgId", "lastAttemptAt");
