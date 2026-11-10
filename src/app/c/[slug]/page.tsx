import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/lib/db";
import { getClientSession } from "@/lib/auth/client-session";
import { ClientShell } from "./client-shell";

export const dynamic = "force-dynamic";

/** Prévia do portal do cliente no WhatsApp: nome da clínica, não o da plataforma. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const org = await db.organization.findUnique({
    where: { slug },
    select: { name: true, description: true, logoUrl: true, status: true },
  });
  if (!org || org.status !== "ACTIVE") return { title: "Área do cliente" };

  const title = `${org.name} - Área do cliente`;
  const description =
    org.description?.trim() || `Acesse seus agendamentos na ${org.name}.`;

  return {
    title: { absolute: title },
    description,
    openGraph: {
      title,
      description,
      siteName: org.name,
      type: "website",
      ...(org.logoUrl?.startsWith("http") ? { images: [{ url: org.logoUrl }] } : {}),
    },
    twitter: {
      card: org.logoUrl?.startsWith("http") ? "summary_large_image" : "summary",
      title,
      description,
      ...(org.logoUrl?.startsWith("http") ? { images: [org.logoUrl] } : {}),
    },
  };
}

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
