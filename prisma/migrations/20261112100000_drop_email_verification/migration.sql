-- A confirmação de e-mail foi substituída pela senha de administrador no cadastro,
-- então as colunas de verificação ficaram sem uso. Sem dados de negócio aqui: só o instante
-- em que cada conta teria confirmado o endereço.
ALTER TABLE "User" DROP COLUMN IF EXISTS "emailVerificationSentAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "emailVerifiedAt";
