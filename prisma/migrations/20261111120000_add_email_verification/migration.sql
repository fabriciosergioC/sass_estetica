-- Confirmação de e-mail no cadastro da clínica.
-- Additive: nenhuma conta existente é bloqueada.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerificationSentAt" TIMESTAMP(3);

-- Quem já tinha conta antes desta regra continua entrando sem clicar em link nenhum.
UPDATE "User" SET "emailVerifiedAt" = NOW();
