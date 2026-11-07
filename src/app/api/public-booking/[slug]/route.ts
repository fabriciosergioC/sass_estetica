import { NextRequest, NextResponse } from "next/server";
import { localDateTime } from "@/lib/datetime";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { createAppointment, BusinessError } from "@/modules/scheduling/appointments";
import { formatPhone } from "@/lib/format";

const publicBookSchema = z.object({
  customerName: z.string().min(1, "Nome do cliente é obrigatório."),
  customerPhone: z.string().regex(/^\+?\d{10,15}$/, "Telefone do cliente inválido."),
  serviceId: z.string().min(1, "Serviço é obrigatório."),
  barberId: z.string().min(1, "Profissional é obrigatório."),
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

// Headers CORS para permitir requisições de origens externas
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * POST /api/public-booking/[slug] - Agendamento público sem necessidade de login.
 * @body { customerName, customerPhone, serviceId, barberId, date, time, notes? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const body = (await req.json().catch(() => ({}))) as z.infer<typeof publicBookSchema>;

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

    // Rate limit baseado no IP e no slug para evitar spam
    const limit = rateLimit(`public-book:${ip}:${slug}`, 5, 60_000); // 5 requisições por minuto
    if (!limit.ok) {
      return NextResponse.json({ error: "Muitas tentativas. Aguarde um momento." }, { status: 429, headers: corsHeaders });
    }

    const parsed = publicBookSchema.parse(body);

    const organization = await db.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!organization) {
      return NextResponse.json({ error: "Clínica não encontrada." }, { status: 404, headers: corsHeaders });
    }
    const orgId = organization.id;

    // Encontra ou cria o cliente
    let customer = await db.customer.findFirst({
      where: { orgId, phone: formatPhone(parsed.customerPhone) },
    });
    if (!customer) {
      customer = await db.customer.create({
        data: {
          orgId,
          name: parsed.customerName,
          phone: formatPhone(parsed.customerPhone),
          whatsappOptIn: true, // Assume opt-in para agendamento público
        },
      });
    }

    const service = await db.service.findFirst({
      where: { id: parsed.serviceId, orgId, active: true },
    });
    if (!service) return NextResponse.json({ error: "Serviço não encontrado." }, { status: 404, headers: corsHeaders });

    const barber = await db.barber.findFirst({
      where: { id: parsed.barberId, orgId, active: true },
    });
    if (!barber) return NextResponse.json({ error: "Profissional não encontrado." }, { status: 404, headers: corsHeaders });

    const performs = await db.barberService.findFirst({
      where: { barberId: barber.id, serviceId: service.id },
    });
    if (!performs) return NextResponse.json({ error: "Este profissional não executa este serviço." }, { status: 400, headers: corsHeaders });

    const startAt = localDateTime(parsed.date, parsed.time);
    if (startAt.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ error: "Escolha um horário futuro." }, { status: 400, headers: corsHeaders });
    }

    let appointment: Awaited<ReturnType<typeof createAppointment>>;
    try {
      appointment = await createAppointment({
        orgId,
        barberId: barber.id,
        customerId: customer.id,
        serviceId: service.id,
        startAt,
        source: "PUBLIC_WEBSITE",
        notes: parsed.notes,
      });
    } catch (err) {
      friendlyError(err);
    }

    return NextResponse.json(
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
      { status: 201, headers: corsHeaders }
    );
  } catch (err) {
    return handleApiError(err, corsHeaders);
  }
}
