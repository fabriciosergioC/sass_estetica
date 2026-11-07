/**
 * Marca (ou desmarca) o administrador da plataforma.
 * Uso: npx tsx scripts/set-superadmin.ts <email> [on|off]
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const [email, mode] = process.argv.slice(2);
  if (!email) throw new Error("informe o e-mail: npx tsx scripts/set-superadmin.ts <email> [on|off]");
  const value = mode !== "off";

  const before = await db.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, isSuperAdmin: true } });
  if (!before) throw new Error(`nenhum usuário com o e-mail ${email}`);

  const user = await db.user.update({
    where: { email },
    data: { isSuperAdmin: value },
    select: { id: true, email: true, name: true, isSuperAdmin: true },
  });

  console.log(`antes: ${before.email} isSuperAdmin=${before.isSuperAdmin}`);
  console.log(`depois: ${user.email} isSuperAdmin=${user.isSuperAdmin}`);

  const supers = await db.user.findMany({ where: { isSuperAdmin: true }, select: { email: true } });
  console.log(`administradores da plataforma agora: ${supers.map((s) => s.email).join(", ") || "nenhum"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
