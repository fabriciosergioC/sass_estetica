import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { getAvailability } from "@/modules/scheduling/availability";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/public/[slug]/slots?serviceId&barberId&date=YYYY-MM-DD — disponibilidade pública (sem auth). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const org = await db.organization.findUnique({ where: { slug } });
    if (!org || org.status !== "ACTIVE") {
      return jsonOk({ error: "Clínica não encontrada." }, 404);
    }

    const url = new URL(req.url);
    const serviceId = url.searchParams.get("serviceId") ?? "";
    const barberId = url.searchParams.get("barberId") ?? "";
    const dateStr = url.searchParams.get("date") ?? "";
    if (!serviceId || !barberId || !dateStr) {
      return jsonOk({ error: "Informe serviço, atendente e data." }, 400);
    }

    const service = await db.service.findFirst({ where: { id: serviceId, orgId: org.id, active: true } });
    if (!service) return jsonOk({ error: "Serviço não encontrado." }, 404);

    const barber = await db.barber.findFirst({ where: { id: barberId, orgId: org.id, active: true } });
    if (!barber) return jsonOk({ error: "Barbeiro não encontrado." }, 404);

    // Mesma regra da disponibilidade pública: sem vínculo específico,
    // assume que o barbeiro pode realizar o serviço.

    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return jsonOk({ error: "Data inválida." }, 400);
    const date = new Date(Date.UTC(y, m - 1, d, 12));

    const slots = await getAvailability({ orgId: org.id, barberId: barber.id, date, durationMin: service.durationMin });
    const response = jsonOk({ slots });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
