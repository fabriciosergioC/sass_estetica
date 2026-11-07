import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession, setSessionCookie } from "@/lib/auth/session";
import { HttpError } from "@/lib/auth/guards";
import { handleApiError } from "@/lib/api";

const schema = z.object({ orgId: z.string().min(1) });

/**
 * O `isSuperAdmin` do JWT é retrato do login e vale 7 dias; a conta no banco é a palavra final.
 * Consultar aqui faz revogar o acesso administrativo valer na hora, e não só na semana que vem.
 */
async function isPlatformAdmin(session: NonNullable<Awaited<ReturnType<typeof getSession>>>): Promise<boolean> {
  const account = await db.user.findUnique({
    where: { id: session.userId },
    select: { isSuperAdmin: true },
  });
  return account?.isSuperAdmin ?? session.isSuperAdmin;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new HttpError(401, "Sessão expirada.");

    const { orgId } = schema.parse(await req.json());

    // Primeiro tenta encontrar no cache da sessão
    const cachedMembership = session.cachedMemberships?.find((m) => m.orgId === orgId);

    let orgName: string;
    let role: string;
    let viaSuperAdmin = false;

    if (cachedMembership) {
      // Usa dados cacheados - sem query no banco
      orgName = cachedMembership.orgName;
      role = cachedMembership.role;
    } else {
      // Fallback: busca no banco se não estiver no cache
      const membership = await db.organizationMember.findFirst({
        where: { userId: session.userId, orgId, status: "ACTIVE" },
        include: { org: true },
      });
      if (membership) {
        orgName = membership.org.name;
        role = membership.role;
      } else if (await isPlatformAdmin(session)) {
        // Administrador da plataforma: entra em qualquer empresa ATIVA mesmo sem vínculo,
        // com o papel que a troca sempre aplicou — ADMIN. O que libera aqui é a SESSÃO
        // (JWT assinado no servidor), não um campo vindo do navegador.
        const org = await db.organization.findFirst({ where: { id: orgId, status: "ACTIVE" } });
        if (!org) throw new HttpError(404, "Empresa não encontrada ou fora do ar.");
        orgName = org.name;
        role = "ADMIN";
        viaSuperAdmin = true;
      } else {
        throw new HttpError(403, "Você não tem acesso a esta clínica.");
      }
    }

    if (viaSuperAdmin) {
      // Visitar a barbearia dos outros deixa rastro: quem era a org de origem e em que papel entrou.
      try {
        await db.auditLog.create({
          data: {
            orgId,
            userId: session.userId,
            action: "org.switch_as_super_admin",
            entity: "Organization",
            entityId: orgId,
            after: JSON.stringify({ fromOrgId: session.activeOrgId ?? null, role }),
          },
        });
      } catch (e) {
        console.error("[switch-org] não foi possível auditar a troca", e);
      }
    }

    await setSessionCookie({
      ...session,
      activeOrgId: orgId,
      role,
      cachedOrgName: orgName,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
