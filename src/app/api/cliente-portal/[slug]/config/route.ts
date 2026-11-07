import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { getClientSession } from "@/lib/auth/client-session";

/** GET /api/cliente-portal/[slug]/config — dados públicos + sessão (se houver). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const org = await db.organization.findUnique({ where: { slug } });
    if (!org || org.status !== "ACTIVE") {
      return jsonOk({ error: "Clínica indisponível." }, 404);
    }

    const [services, barbers, session] = await Promise.all([
      db.service.findMany({
        where: { orgId: org.id, active: true },
        orderBy: [{ category: "asc" }, { name: "asc" }],
        select: { id: true, name: true, category: true, durationMin: true, priceCents: true, description: true },
      }),
      db.barber.findMany({
        where: { orgId: org.id, active: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          bio: true,
          specialties: true,
          services: { select: { serviceId: true } },
        },
      }),
      getClientSession(),
    ]);

    let cliente: { name: string; phone: string } | null = null;
    if (session && session.orgId === org.id) {
      const c = await db.customer.findFirst({
        where: { id: session.customerId, orgId: org.id },
        select: { name: true, phone: true },
      });
      cliente = c ?? null;
    }

    return jsonOk({
      org: {
        name: org.name,
        slug: org.slug,
        primaryColor: org.primaryColor,
        description: org.description,
        address: org.address,
        city: org.city,
        state: org.state,
        instagram: org.instagram,
        phone: org.phone,
      },
      services,
      barbers: barbers.map((b) => ({ ...b, serviceIds: b.services.map((s) => s.serviceId) })),
      cliente,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
