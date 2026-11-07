/**
 * Leitura pura: o que o seletor "trocar de empresa" vai listar para um e-mail.
 * Reproduz as mesmas consultas de GET /api/auth/orgs, sem depender de cookie de sessão.
 * Uso: npx tsx scripts/preview-orgs.ts <email>
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("informe o e-mail: npx tsx scripts/preview-orgs.ts <email>");

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, isSuperAdmin: true },
  });
  if (!user) throw new Error(`nenhum usuário com o e-mail ${email}`);

  const memberships = await db.organizationMember.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    include: { org: { select: { id: true, name: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });
  const byOrg = new Map(memberships.map((m) => [m.orgId, m]));

  let items;
  if (user.isSuperAdmin) {
    const orgs = await db.organization.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    items = orgs.map((o) => ({
      orgName: o.name,
      role: byOrg.get(o.id)?.role ?? "ADMIN",
      viaSuperAdmin: !byOrg.has(o.id),
    }));
  } else {
    const activeIds = new Set(
      (await db.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((o) => o.id)
    );
    items = memberships
      .filter((m) => activeIds.has(m.orgId))
      .map((m) => ({ orgName: m.org.name, role: m.role, viaSuperAdmin: false }));
  }

  console.log(`\n${user.email} | super=${user.isSuperAdmin} | ${items.length} empresa(s) no seletor:`);
  for (const i of items) {
    console.log(`  ${i.orgName} — papel ${i.role}${i.viaSuperAdmin ? " (acesso administrativo)" : ""}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
