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

  return NextResponse.json({
    session: {
      userId: session.userId,
      name: session.name,
      email: session.email,
      activeOrgId: session.activeOrgId,
      role,
      isSuperAdmin: session.isSuperAdmin,
    },
  });
}
