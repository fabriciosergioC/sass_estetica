import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "@/components/toast";
import { AppLayoutShell } from "./app-layout-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.activeOrgId) redirect("/login");

  // Usa dados cacheados da sessão - sem query no banco
  const memberships = session.cachedMemberships ?? [];
  const orgName = session.cachedOrgName ?? "Clínica";

  // Se não tem cache, busca do banco (primeira vez após deploy)
  if (memberships.length === 0) {
    const dbMemberships = await db.organizationMember.findMany({
      where: { userId: session.userId, status: "ACTIVE" },
      include: { org: { select: { id: true, name: true, status: true } } },
      orderBy: { createdAt: "asc" },
      take: 10, // Limite para performance
    });

    if (dbMemberships.length === 0 && !session.isSuperAdmin) redirect("/login");

    memberships.push(
      ...dbMemberships.map((m) => ({
        orgId: m.orgId,
        orgName: m.org.name,
        role: m.role,
      }))
    );
  }

  const active = memberships.find((m) => m.orgId === session.activeOrgId) ?? memberships[0];
  // Administrador da plataforma pode estar numa empresa sem vínculo nenhum com ele; sem esta
  // exceção ele seria expulso para /login por não ter barbearia própria no cache.
  if (!active && !session.isSuperAdmin) redirect("/login");

  // O papel da org ativa vem da sessão: o cache de memberships mostraria o papel de OUTRA
  // barbearia quando ele entra na empresa dos outros como administrador.
  const role = session.role ?? active?.role ?? "ADMIN";

  return (
    <div className="min-h-dvh">
      <Sidebar
        user={{
          name: session.name,
          email: session.email,
          role: role as never,
          orgName: orgName,
          activeOrgId: session.activeOrgId,
          isSuperAdmin: session.isSuperAdmin,
          memberships: memberships,
        }}
      />
      <AppLayoutShell>{children}</AppLayoutShell>
      <Toaster />
    </div>
  );
}
