import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { PublicBooking } from "./booking-flow";

export const dynamic = "force-dynamic";

/**
 * Prévia do link no WhatsApp: cada clínica compartilha /b/{slug} e o cartão precisa
 * mostrar o nome DELA ("Bela Face - Agendamento"), não o nome da plataforma.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const org = await db.organization.findUnique({
    where: { slug },
    select: { name: true, description: true, logoUrl: true, status: true },
  });
  if (!org || org.status !== "ACTIVE") return { title: "Agendamento" };

  const title = `${org.name} - Agendamento`;
  const description =
    org.description?.trim() || `Agende seu horário na ${org.name} direto pelo celular.`;

  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const base = host ? `${proto}://${host}` : "https://gestao-estetica.up.railway.app";
  const image = org.logoUrl?.startsWith("http") ? org.logoUrl : null;

  return {
    metadataBase: new URL(base),
    title: { absolute: title },
    description,
    openGraph: {
      title,
      description,
      siteName: org.name,
      type: "website",
      url: `${base}/b/${slug}`,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function PublicBarbeariaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org || org.status !== "ACTIVE") notFound();

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100" style={{ ["--pub" as string]: org.primaryColor }}>
      <PublicBooking
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
    </div>
  );
}
