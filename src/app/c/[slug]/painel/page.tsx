import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getClientSession } from "@/lib/auth/client-session";
import { ClientSidebar } from "@/components/client-sidebar";
import { PainelClientes } from "./client-panel";

export const dynamic = "force-dynamic";

/** Painel do cliente logado: próximos agendamentos + novo agendamento. */
export default async function ClientePainelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, status: true, name: true, primaryColor: true },
  });
  if (!org || org.status !== "ACTIVE") notFound();

  const session = await getClientSession();
  if (!session || session.orgId !== org.id) redirect(`/c/${slug}`);

  const cliente = await db.customer.findFirst({
    where: { id: session.customerId, orgId: org.id },
    select: { id: true, name: true, phone: true },
  });
  if (!cliente) redirect(`/c/${slug}`);

  return (
    <div className="min-h-dvh">
      <ClientSidebar slug={slug} orgName={org.name} clienteName={cliente.name} />
      <main className="px-4 py-6 lg:ml-64 lg:px-8">
        <PainelClientes
          slug={slug}
          accent={org.primaryColor}
          cliente={{ id: cliente.id, name: cliente.name, phone: cliente.phone }}
        />
      </main>
    </div>
  );
}
