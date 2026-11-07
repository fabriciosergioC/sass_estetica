import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { getAvailability } from "@/modules/scheduling/availability";

/** GET /api/availability?barberId&date=YYYY-MM-DD&serviceId|durationMin */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("appointments:read");
    const url = new URL(req.url);
    const barberId = url.searchParams.get("barberId") ?? "";
    const dateStr = url.searchParams.get("date") ?? "";
    const serviceId = url.searchParams.get("serviceId");

    if (!barberId || !dateStr) {
      return jsonOk({ error: "Informe atendente e data." }, 400);
    }

    let durationMin: number;
    if (serviceId) {
      const service = await db.service.findFirst({ where: { id: serviceId, orgId } });
      if (!service) return jsonOk({ error: "Serviço não encontrado." }, 404);
      durationMin = service.durationMin;
    } else {
      durationMin = Number(url.searchParams.get("durationMin") ?? 30);
    }

    const [y, m, d] = dateStr.split("-").map(Number);
    if (!y || !m || !d) return jsonOk({ error: "Data inválida." }, 400);
    const date = new Date(y, m - 1, d);

    const barber = await db.barber.findFirst({ where: { id: barberId, orgId } });
    if (!barber) return jsonOk({ error: "Barbeiro não encontrado." }, 404);

    const slots = await getAvailability({ orgId, barberId, date, durationMin });
    return jsonOk({ slots });
  } catch (err) {
    return handleApiError(err);
  }
}
