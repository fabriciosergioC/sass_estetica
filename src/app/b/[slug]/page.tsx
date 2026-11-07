import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { PublicBooking } from "./booking-flow";

export const dynamic = "force-dynamic";

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
