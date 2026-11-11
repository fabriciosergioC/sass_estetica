// Detecção de oportunidades: transforma dados em ação.
// Cada oportunidade carrega problema + evidência (explicável) + ação sugerida.
// Idempotente: não duplica oportunidade OPEN para o mesmo refId.
import { db } from "@/lib/db";
import { getAvailability } from "@/modules/scheduling/availability";

type NewOpportunity = {
  type: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  title: string;
  problem: string;
  evidence: string;
  suggestedAction: string;
  actionPayload: Record<string, unknown>;
  refId: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

async function upsertOpen(orgId: string, op: NewOpportunity) {
  const existing = await db.opportunity.findFirst({
    where: { orgId, type: op.type, refId: op.refId, status: "OPEN" },
  });
  if (existing) return;
  await db.opportunity.create({
    data: {
      orgId,
      type: op.type,
      priority: op.priority,
      title: op.title,
      problem: op.problem,
      evidence: op.evidence,
      suggestedAction: op.suggestedAction,
      actionPayload: JSON.stringify(op.actionPayload),
      refId: op.refId,
    },
  });
}

/** Clientes com retorno atrasado / inativos (baseado em métricas reais). */
async function detectReturnOpportunities(orgId: string) {
  const metrics = await db.customerMetrics.findMany({
    where: {
      customer: { orgId },
      visits: { gte: 2 },
      lastVisitAt: { not: null },
      segment: { in: ["RETURN_DUE", "INACTIVE"] },
    },
    include: {
      customer: { select: { id: true, name: true } },
    },
    take: 200,
  });

  const seen = new Set<string>();
  for (const m of metrics) {
    if (seen.has(m.customerId)) continue;
    seen.add(m.customerId);
    const overdue = m.avgIntervalDays && m.lastVisitAt
      ? Math.round((Date.now() - m.lastVisitAt.getTime()) / DAY_MS - m.avgIntervalDays)
      : null;
    const inactive = m.segment === "INACTIVE";

    await upsertOpen(orgId, {
      type: inactive ? "INACTIVE_CUSTOMER" : "RETURN_DUE",
      priority: inactive ? "HIGH" : "MEDIUM",
      title: `${m.customer.name} ${inactive ? "está inativo" : "está atrasado para retornar"}`,
      problem: inactive
        ? `${m.customer.name} não volta há ${Math.round((Date.now() - (m.lastVisitAt?.getTime() ?? 0)) / DAY_MS)} dias.`
        : `${m.customer.name} está ${overdue ?? "?"} dias acima do intervalo médio de ${m.avgIntervalDays} dias.`,
      evidence: `${m.visits} atendimentos; última visita em ${m.lastVisitAt?.toLocaleDateString("pt-BR")}; segmento ${m.segment}.`,
      suggestedAction: "Enviar campanha de retorno pelo WhatsApp.",
      actionPayload: { customerId: m.customerId, template: "return_due" },
      refId: m.customerId,
    });
  }
}

/**
 * Clientes sem nenhum agendamento futuro.
 *
 * "Futuro" é a mesma régua que a Agenda usa: `startAt` a partir de agora com status
 * SCHEDULED ou CONFIRMED. Cancelado/remarcado não conta — o cliente continua sem próximo
 * horário e precisa ser chamado.
 *
 * Antes de criar, resolve o que deixou de valer: quem estava sem horário e passou a ter um
 * (agendou pela Agenda, pelo portal ou pelo link público) sai da lista na hora em que a
 * detecção roda. Sem isso a oportunidade ficava aberta para sempre e o filtro mentia.
 */
async function detectNoUpcoming(orgId: string) {
  const now = new Date();

  const openOnes = await db.opportunity.findMany({
    where: { orgId, type: "NO_UPCOMING", status: "OPEN", refId: { not: null } },
    select: { id: true, refId: true },
    take: 500,
  });
  if (openOnes.length > 0) {
    const withUpcoming = await db.appointment.findMany({
      where: {
        orgId,
        customerId: { in: openOnes.map((op) => op.refId!).filter(Boolean) },
        startAt: { gte: now },
        status: { in: ["SCHEDULED", "CONFIRMED"] },
      },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    const resolvedIds = new Set(withUpcoming.map((appointment) => appointment.customerId));
    const staleIds = openOnes
      .filter((op) => op.refId && resolvedIds.has(op.refId))
      .map((op) => op.id);
    if (staleIds.length > 0) {
      await db.opportunity.updateMany({
        where: { id: { in: staleIds } },
        data: { status: "ACTION_TAKEN", resolvedAt: new Date() },
      });
    }
  }

  const customers = await db.customer.findMany({
    where: {
      orgId,
      appointments: {
        none: {
          startAt: { gte: now },
          status: { in: ["SCHEDULED", "CONFIRMED"] },
        },
      },
    },
    select: {
      id: true,
      name: true,
      createdAt: true,
      metrics: { select: { visits: true, lastVisitAt: true } },
      appointments: {
        where: { status: "COMPLETED" },
        orderBy: { startAt: "desc" },
        take: 1,
        select: { startAt: true },
      },
      _count: { select: { appointments: { where: { status: "COMPLETED" } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  for (const customer of customers) {
    const visits = Math.max(customer.metrics?.visits ?? 0, customer._count.appointments);
    const lastVisitAt = customer.appointments[0]?.startAt ?? customer.metrics?.lastVisitAt ?? null;
    const returning = visits > 0;

    await upsertOpen(orgId, {
      type: "NO_UPCOMING",
      priority: returning ? "HIGH" : "MEDIUM",
      title: `${customer.name} está sem próximo agendamento`,
      problem: returning
        ? `${customer.name} já foi atendido ${visits} ${visits === 1 ? "vez" : "vezes"} e não tem próximo horário marcado.`
        : `${customer.name} está cadastrado, mas não tem nenhum agendamento futuro.`,
      evidence: returning && lastVisitAt
        ? `${visits} atendimento(s) concluído(s); última visita em ${lastVisitAt.toLocaleDateString("pt-BR")}; nenhum agendamento futuro.`
        : `Cadastro criado em ${customer.createdAt.toLocaleDateString("pt-BR")}; nenhum agendamento futuro.`,
      suggestedAction: "Chamar no WhatsApp para marcar o próximo horário.",
      actionPayload: { customerId: customer.id, template: "return_due" },
      refId: customer.id,
    });
  }
}

/** Próximos agendamentos com alto risco de falta. */
async function detectRiskAppointments(orgId: string) {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * DAY_MS);
  const appointments = await db.appointment.findMany({
    where: {
      orgId,
      startAt: { gte: from, lte: to },
      status: { in: ["SCHEDULED", "CONFIRMED"] },
      customer: { metrics: { riskScore: { gte: 60 } } },
    },
    include: {
      customer: { select: { id: true, name: true, metrics: { select: { riskScore: true, noShows: true } } } },
    },
    take: 100,
  });

  for (const a of appointments) {
    const score = a.customer.metrics?.riskScore ?? 0;
    await upsertOpen(orgId, {
      type: "RISK_APPOINTMENT",
      priority: score >= 80 ? "HIGH" : "MEDIUM",
      title: `Risco de falta: ${a.customer.name} (${a.startAt.toLocaleDateString("pt-BR")})`,
      problem: `Agendamento de ${a.customer.name} às ${a.startAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} apresenta risco alto de não comparecimento.`,
      evidence: `Score de risco ${score}/100; ${a.customer.metrics?.noShows ?? 0} falta(s) no histórico.`,
      suggestedAction: "Solicitar confirmação ou enviar lembrete reforçado.",
      actionPayload: { appointmentId: a.id, customerId: a.customer.id, template: "reminder_2h" },
      refId: a.id,
    });
  }
}

/** Horários de hoje/amanhã com baixa ocupação (ociosos). */
async function detectIdleSlots(orgId: string) {
  const barbers = await db.barber.findMany({
    where: { orgId, active: true },
    select: { id: true, name: true },
    take: 20,
  });
  const services = await db.service.findMany({
    where: { orgId, active: true },
    orderBy: { durationMin: "asc" },
    select: { id: true, durationMin: true },
    take: 1,
  });
  if (barbers.length === 0 || services.length === 0) return;
  const durationMin = services[0].durationMin;

  for (const dayOffset of [0, 1]) {
    const day = new Date();
    day.setDate(day.getDate() + dayOffset);
    const date = new Date(day.getFullYear(), day.getMonth(), day.getDate());

    for (const barber of barbers) {
      const slots = await getAvailability({ orgId, barberId: barber.id, date, durationMin });
      const free = slots.filter((s) => s.available);
      const total = slots.length;
      if (total < 4) continue;
      const freeRatio = free.length / total;
      if (freeRatio < 0.4) continue;

      const firstFree = free[0];
      const refId = `${date.toISOString().slice(0, 10)}:${barber.id}`;
      await upsertOpen(orgId, {
        type: "IDLE_SLOT",
        priority: freeRatio > 0.7 ? "HIGH" : "MEDIUM",
        title: `Horário ocioso: ${barber.name} ${
          dayOffset === 0 ? "hoje" : "amanhã"
        } às ${firstFree.start}`,
        problem: `${barber.name} tem ${free.length} de ${total} horários livres ${
          dayOffset === 0 ? "hoje" : "amanhã"
        }.`,
        evidence: `Ocupação de ${Math.round((1 - freeRatio) * 100)}% neste dia; primeiro horário livre às ${firstFree.start}.`,
        suggestedAction: "Recuperar horário com clientes compatíveis.",
        actionPayload: {
          slot: { date: refId.slice(0, 10), time: firstFree.start, barberId: barber.id },
          template: "slot_recovery",
        },
        refId,
      });
    }
  }
}

/** Fecha oportunidades cujo contexto expirou (7 dias sem ação). */
async function expireStale(orgId: string) {
  const cutoff = new Date(Date.now() - 7 * DAY_MS);
  await db.opportunity.updateMany({
    where: { orgId, status: "OPEN", detectedAt: { lt: cutoff }, type: { in: ["IDLE_SLOT", "RISK_APPOINTMENT"] } },
    data: { status: "EXPIRED", resolvedAt: new Date() },
  });
}

/** Roda todos os detectores para uma organização. Seguro chamar repetidamente. */
export async function detectOpportunities(orgId: string): Promise<number> {
  const before = await db.opportunity.count({ where: { orgId, status: "OPEN" } });
  await Promise.all([
    detectReturnOpportunities(orgId),
    detectNoUpcoming(orgId),
    detectRiskAppointments(orgId),
    detectIdleSlots(orgId),
    expireStale(orgId),
  ]);
  const after = await db.opportunity.count({ where: { orgId, status: "OPEN" } });
  return Math.max(0, after - before);
}
