import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

/**
 * Sessão para a interface. O papel vem do banco: se o nível de acesso mudou depois do login,
 * a tela precisa esconder/mostrar o que o servidor já aplica hoje.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ session: null });

  let role = session.role ?? null;
  if (session.activeOrgId) {
    const member = await db.organizationMember.findUnique({
      where: { orgId_userId: { orgId: session.activeOrgId, userId: session.userId } },
      select: { role: true, status: true },
    });
    if (member?.status === "ACTIVE") role = member.role;
    else if (session.isSuperAdmin) role = "ADMIN";
    else role = null;
  }

  // Nome da clínica ativa: o cabeçalho de impressão dos relatórios sai em papel com a empresa
  // no topo, e a página é client component — o valor do JWT pode estar velho, então lemos do banco.
  let orgName = session.cachedOrgName ?? null;
  if (!orgName && session.activeOrgId) {
    const org = await db.organization.findUnique({
      where: { id: session.activeOrgId },
      select: { name: true },
    });
    orgName = org?.name ?? null;
  }

  return NextResponse.json({
    session: {
      userId: session.userId,
      name: session.name,
      email: session.email,
      activeOrgId: session.activeOrgId,
      role,
      isSuperAdmin: session.isSuperAdmin,
      orgName,
    },
  });
}
