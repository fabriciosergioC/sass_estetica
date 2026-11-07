import { NextRequest, NextResponse } from "next/server";
import { localDateTime } from "@/lib/datetime";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { requireClienteOrg } from "@/lib/auth/client-guards";
import { createAppointment, changeStatus, BusinessError, assertTransition, type AppointmentStatus } from "@/modules/scheduling/appointments";

const bookSchema = z.object({
  serviceId: z.string().min(1),
  barberId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido."),
  notes: z.string().trim().max(500).optional(),
});

function friendlyError(err: unknown): never {
  if (err instanceof BusinessError) throw err;
  if (err instanceof Error && err.message.startsWith("CONFLITO:")) {
    throw new BusinessError(
      `Este horário acabou de ser ocupado (conflito às ${err.message.split(":")[1]}). Escolha outro horário.`
    );
  }
  if (err instanceof Error && err.message.startsWith("FORA_DO_HORARIO:")) {
    throw new BusinessError(err.message.split(":").slice(1).join(":"));
  }
  throw err;
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * POST /api/cliente-portal/[slug]/appointments
 *  - { action: "book", serviceId, barberId, date, time } → agendar
 *  - { action: "cancel", appointmentId } → cancelar um agendamento FUTURO
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;

    // Suporte a CORS para requisições externas (como a pasta barbearia)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    const sessionResult = await requireClienteOrg().catch(() => null);
    if (!sessionResult) {
      return NextResponse.json({ error: "Não autorizado." }, { status: 401, headers: corsHeaders });
    }
    const { session, orgId } = sessionResult;

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

    const body = (await req.json().catch(() => ({}))) as { action?: string };

    if (body.action === "cancel") {
      const cancelSchema = z.object({ appointmentId: z.string().min(1) });
      const parsed = cancelSchema.parse(body);

      const appt = await db.appointment.findFirst({
        where: { id: parsed.appointmentId, orgId, customerId: session.customerId },
      });
      if (!appt) return jsonOk({ error: "Agendamento não encontrado." }, 404);
      if (!["SCHEDULED", "CONFIRMED", "IN_SERVICE"].includes(appt.status)) {
        return jsonOk({ error: "Este agendamento já foi finalizado." }, 400);
      }

      try {
        assertTransition(appt.status as AppointmentStatus, "CANCELLED");
      } catch {
        return jsonOk({ error: "Não é possível cancelar neste status." }, 400);
      }

      await changeStatus({
        orgId,
        userId: null,
        appointmentId: appt.id,
        to: "CANCELLED",
        reason: "Cancelado pelo cliente no portal",
      });

      return jsonOk({ ok: true });
    }

    // action: "book" é o padrão
    const limit = rateLimit(`cliente-book:${ip}:${session.customerId}`, 10, 60_000);
    if (!limit.ok) {
      return jsonOk({ error: "Muitas tentativas. Aguarde um momento." }, 429);
    }

    const parsed = bookSchema.parse(body);

    const service = await db.service.findFirst({
      where: { id: parsed.serviceId, orgId, active: true },
    });
    if (!service) return jsonOk({ error: "Serviço não encontrado." }, 404);

    const barber = await db.barber.findFirst({
      where: { id: parsed.barberId, orgId, active: true },
    });
    if (!barber) return jsonOk({ error: "Barbeiro não encontrado." }, 404);

    const performs = await db.barberService.findFirst({
      where: { barberId: barber.id, serviceId: service.id },
    });
    if (!performs) return jsonOk({ error: "Este atendente não executa este serviço." }, 400);

    const startAt = localDateTime(parsed.date, parsed.time);
    if (startAt.getTime() < Date.now() - 60_000) {
      return jsonOk({ error: "Escolha um horário futuro." }, 400);
    }

    let appointment: Awaited<ReturnType<typeof createAppointment>>;
    try {
      appointment = await createAppointment({
        orgId,
        barberId: barber.id,
        customerId: session.customerId,
        serviceId: service.id,
        startAt,
        source: "PUBLIC",
        notes: parsed.notes,
      });
    } catch (err) {
      friendlyError(err);
    }

    return jsonOk(
      {
        ok: true,
        appointment: {
          id: appointment.id,
          serviceName: service.name,
          barberName: barber.name,
          date: parsed.date,
          time: parsed.time,
          priceCents: service.priceCents,
        },
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}
