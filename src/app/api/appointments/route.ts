import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { createAppointment, BusinessError } from "@/modules/scheduling/appointments";

function friendlyError(err: unknown): never {
  if (err instanceof BusinessError) throw err;
  if (err instanceof Error && err.message.startsWith("CONFLITO:")) {
    throw new BusinessError(`Este horário acabou de ser ocupado (conflito às ${err.message.split(":")[1]}). Escolha outro horário.`);
  }
  if (err instanceof Error && err.message.startsWith("FORA_DO_HORARIO:")) {
    throw new BusinessError(err.message.split(":").slice(1).join(":"));
  }
  throw err;
}

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("appointments:read");
    const url = new URL(req.url);
    const from = url.searchParams.get("from"); // YYYY-MM-DD
    const to = url.searchParams.get("to"); // YYYY-MM-DD
    const barberId = url.searchParams.get("barberId");
    const customerId = url.searchParams.get("customerId");
    const status = url.searchParams.get("status");

    const startAt = from ? new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10))) : undefined;
    const endBase = to ? new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10))) : undefined;
    const endAt = endBase ? new Date(endBase.getTime() + 24 * 60 * 60 * 1000) : undefined;

    const appointments = await db.appointment.findMany({
      where: {
        orgId,
        ...(startAt || endAt ? { startAt: { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lt: endAt } : {}) } } : {}),
        ...(barberId ? { barberId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { startAt: "asc" },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        barber: { select: { id: true, name: true } },
        service: { select: { id: true, name: true, durationMin: true } },
      },
    });

    return jsonOk({ items: appointments });
  } catch (err) {
    return handleApiError(err);
  }
}

const createSchema = z.object({
  customerId: z.string().min(1),
  barberId: z.string().min(1),
  serviceId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Hora inválida"),
  notes: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("appointments:write");
    const body = createSchema.parse(await req.json());

    const [y, m, d] = body.date.split("-").map(Number);
    const [hh, mm] = body.time.split(":").map(Number);
    const startAt = new Date(y, m - 1, d, hh, mm);

    try {
      const appointment = await createAppointment({
        orgId,
        userId: session.userId,
        barberId: body.barberId,
        customerId: body.customerId,
        serviceId: body.serviceId,
        startAt,
        source: "ADMIN",
        notes: body.notes,
      });
      return jsonOk({ appointment }, 201);
    } catch (err) {
      friendlyError(err);
    }
  } catch (err) {
    return handleApiError(err);
  }
}
