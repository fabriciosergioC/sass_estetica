import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { createAppointment } from "@/modules/scheduling/appointments";
import { formatPhone } from "@/lib/format";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const body = await req.json().catch(() => ({}));

    console.log("[Public Booking] Recebido payload:", body);

    const organization = await db.organization.findUnique({ where: { slug }, select: { id: true } });
    if (!organization) {
      return NextResponse.json({ error: "Clínica não encontrada." }, { status: 404, headers: corsHeaders });
    }
    const orgId = organization.id;

    // Extrai dados suportando múltiplos formatos possíveis do frontend
    const customerData = body.customer || {};
    const customerName = customerData.name || "Cliente Web";
    const customerPhone = customerData.phone || customerData.whatsapp || "11999999999";

    const serviceId = body.serviceId || (typeof body.service === "object" ? body.service?.id : body.service);
    const barberId = body.barberId || "any";
    const dateStr = body.date;
    const timeStr = body.start || body.time;

    if (!serviceId || !dateStr || !timeStr) {
      return NextResponse.json({ error: "Dados incompletos (serviço, data ou horário em falta)." }, { status: 400, headers: corsHeaders });
    }

    // Encontra ou cria o cliente
    let customer = await db.customer.findFirst({
      where: { orgId, phone: formatPhone(customerPhone) },
    });
    if (!customer) {
      customer = await db.customer.create({
        data: {
          orgId,
          name: customerName,
          phone: formatPhone(customerPhone),
          whatsappOptIn: true,
        },
      });
    }

    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = timeStr.split(":").map(Number);
    const startAt = new Date(y, m - 1, d, hh, mm);

    // Resolve o barbeiro (se "any", pega o primeiro disponível ou ativo)
    let targetBarberId = barberId;
    if (!targetBarberId || targetBarberId === "any") {
      const firstBarber = await db.barber.findFirst({ where: { orgId, active: true } });
      if (!firstBarber) {
        return NextResponse.json({ error: "Nenhum profissional disponível encontrado." }, { status: 400, headers: corsHeaders });
      }
      targetBarberId = firstBarber.id;
    }

    const appointment = await createAppointment({
      orgId,
      barberId: targetBarberId,
      customerId: customer.id,
      serviceId,
      startAt,
      source: "PUBLIC_WEBSITE",
    });

    return NextResponse.json({ ok: true, appointment }, { status: 201, headers: corsHeaders });
  } catch (err) {
    console.error("[Public Booking] Erro ao criar agendamento:", err);
    return handleApiError(err, corsHeaders);
  }
}
