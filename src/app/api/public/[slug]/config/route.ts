import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/public/[slug]/config — dados públicos da barbearia (sem auth). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const org = await db.organization.findUnique({ where: { slug } });
    if (!org || org.status !== "ACTIVE") {
      return jsonOk({ error: "Clínica não encontrada." }, 404);
    }

    const [services, barbers] = await Promise.all([
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
    ]);

    const response = jsonOk({
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
    });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    return response;

  } catch (err) {
    return handleApiError(err);
  }
}
