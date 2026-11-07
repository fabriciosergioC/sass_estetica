import { getClientSession, type ClientSessionPayload } from "./client-session";
import { HttpError } from "./guards";

/**
 * Exige sessão de CLIENTE no portal. O cookie é outro — nunca a sessão de gestão.
 * Também garante que o cliente e a org ainda existam (auto-cadastro pode ser
 * removido a qualquer momento pelo dono da barbearia).
 */
export async function requireCliente(): Promise<{ session: ClientSessionPayload; orgId: string }> {
  const session = await getClientSession();
  if (!session) throw new HttpError(401, "Sessão expirada. Entre novamente.");
  return { session, orgId: session.orgId };
}

export async function requireClienteOrg(): Promise<{ session: ClientSessionPayload; orgId: string }> {
  const { db } = await import("@/lib/db");
  const { session, orgId } = await requireCliente();
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true, status: true } });
  if (!org || org.status !== "ACTIVE") throw new HttpError(403, "Clínica indisponível.");
  return { session, orgId: session.orgId };
}
