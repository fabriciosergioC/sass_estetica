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

/** Exige sessão válida e org ativa; retorna contexto multi-tenant. */
export async function requireOrg(): Promise<OrgContext> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Sessão expirada. Faça login novamente.");
  if (session.tokenVersion === undefined) throw new HttpError(401, "Sessão inválida.");
  if (!session.activeOrgId || !session.role) {
    throw new HttpError(403, "Nenhuma clínica ativa na sessão.");
  }
  return { session, orgId: session.activeOrgId, role: session.role };
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
