import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { normalizePhone } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";
import { createAppointment, BusinessError } from "@/modules/scheduling/appointments";
import { publishEvent } from "@/modules/automation/events";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

const bookSchema = z.object({
  serviceId: z.string().min(1),
  barberId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido."),
  name: z.string().trim().min(2, "Informe seu nome.").max(80),
  phone: z.string().trim().min(10, "Telefone inválido.").max(20),
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

/** POST /api/public/[slug]/book — agendamento público em 5 passos (sem auth). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = rateLimit(`book:${ip}`, 8, 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: "Muitas tentativas. Aguarde um momento e tente novamente." }, { status: 429, headers: corsHeaders });
    }

    const { slug } = await params;
    const org = await db.organization.findUnique({ where: { slug }, select: { id: true, name: true, status: true } }); // Adicionado select para name
    if (!org || org.status !== "ACTIVE") {
      return NextResponse.json({ error: "Clínica não encontrada." }, { status: 404, headers: corsHeaders });
    }

    const body = bookSchema.parse(await req.json());

    const service = await db.service.findFirst({ where: { id: body.serviceId, orgId: org.id, active: true } });
    if (!service) return NextResponse.json({ error: "Serviço não encontrado." }, { status: 404, headers: corsHeaders });

    const barber = await db.barber.findFirst({ where: { id: body.barberId, orgId: org.id, active: true } });
    if (!barber) return NextResponse.json({ error: "Barbeiro não encontrado." }, { status: 404, headers: corsHeaders });

    const performs = await db.barberService.findFirst({
      where: { barberId: barber.id, serviceId: service.id },
    });
    if (!performs) return NextResponse.json({ error: "Este atendente não executa este serviço." }, { status: 400, headers: corsHeaders });

    const [y, m, d] = body.date.split("-").map(Number);
    const [hh, mm] = body.time.split(":").map(Number);
    const startAt = new Date(y, m - 1, d, hh, mm);
    if (startAt.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ error: "Escolha um horário futuro." }, { status: 400, headers: corsHeaders });
    }

    const phone = normalizePhone(body.phone);
    if (!phone || phone.length < 11) {
      return NextResponse.json({ error: "Telefone inválido. Inclua DDD." }, { status: 400, headers: corsHeaders });
    }

    let customer = await db.customer.findFirst({ where: { orgId: org.id, phone } });
    let isNewCustomer = false;
    if (!customer) {
      console.log("[Book API] Creating new customer with name:", body.name, "and phone:", phone);
      customer = await db.customer.create({
        data: { orgId: org.id, name: body.name, phone },
      });
      isNewCustomer = true;
    } else {
      console.log("[Book API] Found existing customer:", customer.name, customer.phone);
    }

    let appointment: Awaited<ReturnType<typeof createAppointment>>;
    try {
      appointment = await createAppointment({
        orgId: org.id,
        barberId: barber.id,
        customerId: customer.id,
        serviceId: service.id,
        startAt,
        source: "PUBLIC",
        notes: body.notes,
      });
    } catch (err) {
      friendlyError(err);
    }

    if (isNewCustomer) {
      await publishEvent(org.id, "customer.created", { customerId: customer.id });
    }

    return NextResponse.json(
      {
        ok: true,
        appointment: {
          id: appointment.id,
          serviceName: service.name,
          barberName: barber.name,
          date: body.date,
          time: body.time,
          priceCents: service.priceCents,
          orgName: org.name, // Adicionado org.name para retorno ao frontend
        },
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (err) {
    return handleApiError(err, corsHeaders);
  }
}
