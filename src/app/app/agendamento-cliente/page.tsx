import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { PublicBooking } from "../../b/[slug]/booking-flow";

export const dynamic = "force-dynamic";

export default async function AgendamentoClientePage() {
  const session = await getSession();
  if (!session || !session.activeOrgId) redirect("/login");

  const org = await db.organization.findUnique({
    where: { id: session.activeOrgId },
    select: {
      id: true,
      name: true,
      slug: true,
      primaryColor: true,
      description: true,
      address: true,
      city: true,
      state: true,
      instagram: true,
      phone: true,
      status: true
    }
  });

  if (!org || org.status !== "ACTIVE") redirect("/login");

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
