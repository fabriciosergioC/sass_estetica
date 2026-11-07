import { NextRequest } from "next/server";
import { z } from "zod";
import { localDateTime } from "@/lib/datetime";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import {
  rescheduleAppointment,
  changeStatus,
  BusinessError,
  type AppointmentStatus,
} from "@/modules/scheduling/appointments";

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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("appointments:read");
    const { id } = await params;

    const appointment = await db.appointment.findFirst({
      where: { id, orgId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        barber: { select: { id: true, name: true } },
        service: { select: { id: true, name: true, durationMin: true, priceCents: true } },
        statusHistory: { orderBy: { createdAt: "asc" } },
        payments: true,
      },
    });
    if (!appointment) return jsonOk({ error: "Agendamento não encontrado." }, 404);

    return jsonOk({ appointment });
  } catch (err) {
    return handleApiError(err);
  }
}

const rescheduleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  barberId: z.string().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("appointments:write");
    const { id } = await params;
    const body = rescheduleSchema.parse(await req.json());

    const newStartAt = localDateTime(body.date, body.time);

    try {
      const appointment = await rescheduleAppointment({
        orgId,
        userId: session.userId,
        appointmentId: id,
        newStartAt,
        newBarberId: body.barberId,
      });
      return jsonOk({ appointment });
    } catch (err) {
      friendlyError(err);
    }
  } catch (err) {
    return handleApiError(err);
  }
}

const statusSchema = z.object({
  to: z.enum(["CONFIRMED", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW"]),
  reason: z.string().max(300).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("appointments:write");
    const { id } = await params;
    const body = statusSchema.parse(await req.json());

    try {
      const appointment = await changeStatus({
        orgId,
        userId: session.userId,
        appointmentId: id,
        to: body.to as AppointmentStatus,
        reason: body.reason,
      });
      return jsonOk({ appointment, whatsapp: (appointment as any).whatsapp ?? null });
    } catch (err) {
      friendlyError(err);
    }
  } catch (err) {
    return handleApiError(err);
  }
}
