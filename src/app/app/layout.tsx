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

  // O papel dentro do JWT é o retrato do login e vale 7 dias. Se um administrador mudou o
  // nível de acesso depois, o menu precisa refletir o banco agora — por isso a consulta.
  const member = await db.organizationMember.findUnique({
    where: { orgId_userId: { orgId: session.activeOrgId, userId: session.userId } },
    select: { role: true, status: true },
  });

  // Vínculo removido/desativado tira a pessoa do painel. Administrador da plataforma pode
  // estar numa empresa sem vínculo nenhum e continua entrando como ADMIN.
  if ((!member || member.status !== "ACTIVE") && !session.isSuperAdmin) redirect("/login");

  const role = member?.status === "ACTIVE" ? member.role : "ADMIN";

  let orgName = session.cachedOrgName;
  if (!orgName) {
    const org = await db.organization.findUnique({
      where: { id: session.activeOrgId },
      select: { name: true },
    });
    orgName = org?.name ?? "Clínica";
  }

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
        }}
      />
      <AppLayoutShell>{children}</AppLayoutShell>
      <Toaster />
    </div>
  );
}
