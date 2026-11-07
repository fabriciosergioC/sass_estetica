import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

export const dynamic = "force-dynamic";

/**
 * Layout do PORTAL DO CLIENTE por barbearia — /c/{slug}.
 * Mesma linguagem visual do painel de gestão (zinc-950, cards, sidebar) com a
 * cor principal da barbearia injetada como variável --accent-c.
 */
export default async function ClientePortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true, status: true, primaryColor: true, name: true },
  });
  if (!org || org.status !== "ACTIVE") notFound();

  return (
    <div
      className="min-h-dvh bg-zinc-950 text-zinc-100"
      style={{ ["--accent-c" as keyof CSSProperties]: org.primaryColor } as CSSProperties}
    >
      {children}
    </div>
  );
}
