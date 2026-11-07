import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { getSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/auth/guards";

/**
 * GET /api/auth/orgs — a lista de empresas do seletor "trocar de empresa".
 *
 * Existe porque o seletor lia `session.cachedMemberships`, um retrato congelado no login:
 * empresa criada depois nunca aparecia sem sair e entrar de novo. Aqui a lista vem do banco
 * a cada abertura do menu.
 *
 * Quem é membro normal recebe só as próprias empresas. Quem é administrador da plataforma
 * (`isSuperAdmin`, conferido na SESSÃO — nunca em campo vindo do navegador) recebe todas as
 * empresas ATIVAS, com `viaSuperAdmin: true` nas que ele não tem vínculo, para a interface
 * deixar claro que aquilo é acesso administrativo e não uma barbearia dele.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) throw new HttpError(401, "Sessão expirada. Faça login novamente.");

    // O JWT carrega `isSuperAdmin` do momento do login e vale 7 dias. Consultar a conta faz a
    // promoção (ou a revogação) valer na hora, sem precisar sair e entrar de novo.
    const account = await db.user.findUnique({
      where: { id: session.userId },
      select: { isSuperAdmin: true },
    });
    const isSuperAdmin = account?.isSuperAdmin ?? session.isSuperAdmin;

    const memberships = await db.organizationMember.findMany({
      where: { userId: session.userId, status: "ACTIVE" },
      include: { org: { select: { id: true, name: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    const byOrg = new Map(memberships.map((m) => [m.orgId, m]));

    let items: Array<{ orgId: string; orgName: string; role: string; viaSuperAdmin: boolean }>;

    if (isSuperAdmin) {
      const orgs = await db.organization.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      items = orgs.map((o) => ({
        orgId: o.id,
        orgName: o.name,
        // Sem vínculo o papel vem da sessão ao entrar; aqui adiantamos o ADMIN que o
        // switch-org vai aplicar, para a lista bater com o que a troca de fato faz.
        role: byOrg.get(o.id)?.role ?? "ADMIN",
        viaSuperAdmin: !byOrg.has(o.id),
      }));
    } else {
      const orgIds = memberships.map((m) => m.orgId);
      const active = await db.organization.findMany({
        where: { id: { in: orgIds }, status: "ACTIVE" },
        select: { id: true },
      });
      const activeIds = new Set(active.map((o) => o.id));
      items = memberships
        .filter((m) => activeIds.has(m.orgId))
        .map((m) => ({
          orgId: m.orgId,
          orgName: m.org.name,
          role: m.role,
          viaSuperAdmin: false,
        }));
    }

    return jsonOk({
      items,
      activeOrgId: session.activeOrgId ?? null,
      isSuperAdmin,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
