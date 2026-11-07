import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getClientSession } from "@/lib/auth/client-session";
import { ClientShell } from "./client-shell";

export const dynamic = "force-dynamic";

export default async function ClientePortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await db.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      status: true,
      name: true,
      slug: true,
      primaryColor: true,
      description: true,
      address: true,
      city: true,
      state: true,
      instagram: true,
      phone: true,
    },
  });
  if (!org || org.status !== "ACTIVE") notFound();

  const session = await getClientSession();
  const logged = !!session && session.orgId === org.id;

  // Cliente logado é levado direto ao painel; sem sessão, mostra login dentro do shell
  if (logged) redirect(`/c/${slug}/painel`);

  return (
    <ClientShell
      slug={slug}
      org={{
        name: org.name,
        slug: org.slug,
        primaryColor: org.primaryColor,
        description: org.description,
        address: org.address,
        city: org.city,
        state: org.state,
        instagram: org.instagram,
        phone: org.phone,
      }}
    />
  );
}
