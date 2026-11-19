import { db } from "@/lib/db";
import { getSession, type SessionPayload } from "./session";
import { assertCan, type Permission } from "./permissions";

export type OrgContext = {
  session: SessionPayload;
  orgId: string;
  role: string;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Papel que a pessoa tem HOJE na clínica ativa.
 *
 * O papel dentro do JWT é o retrato do login e vale 7 dias. Quando um administrador muda o
 * nível de acesso de alguém, o token daquela pessoa continua com o papel antigo. Por isso a
 * cada requisição conferimos o vínculo no banco: assim diminuir o acesso vale na hora.
 * Administrador da plataforma entra em qualquer empresa como ADMIN, mesmo sem vínculo.
 */
async function activeRole(session: SessionPayload, orgId: string): Promise<string> {
  const member = await db.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId: session.userId } },
    select: { role: true, status: true },
  });

  if (member) {
    if (member.status !== "ACTIVE" && !session.isSuperAdmin) {
      throw new HttpError(403, "Seu acesso a esta clínica está desativado.");
    }
    return member.status === "ACTIVE" ? member.role : "ADMIN";
  }

  if (session.isSuperAdmin) return "ADMIN";
  throw new HttpError(403, "Você não tem acesso a esta clínica.");
}

/** Exige sessão válida e org ativa; retorna contexto multi-tenant. */
export async function requireOrg(): Promise<OrgContext> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Sessão expirada. Faça login novamente.");
  if (session.tokenVersion === undefined) throw new HttpError(401, "Sessão inválida.");
  if (!session.activeOrgId || !session.role) {
    throw new HttpError(403, "Nenhuma clínica ativa na sessão.");
  }
  const role = await activeRole(session, session.activeOrgId);
  return { session, orgId: session.activeOrgId, role };
}

/** Exige sessão + org + permissão específica. */
export async function requirePermission(permission: Permission): Promise<OrgContext> {
  const ctx = await requireOrg();
  assertCan(ctx.role, permission);
  return ctx;
}

/** Exige super admin da plataforma. */
export async function requireSuperAdmin(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Sessão expirada. Faça login novamente.");
  if (!session.isSuperAdmin) throw new HttpError(403, "Acesso restrito à administração da plataforma.");
  return session;
}
