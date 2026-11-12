import { db } from "@/lib/db";
import { assertSlotFree } from "./availability";
import { isBusinessSameDay } from "@/lib/datetime";
import { publishEvent } from "@/modules/automation/events";
import { ruleTemplate } from "@/modules/automation/rules";
import { enqueueJob } from "@/modules/automation/jobs";
import { sendTemplateMessage, formatDateTimeBR, type AppointmentVars } from "@/modules/whatsapp/messages";
import { publishAppointmentEvent } from "./appointments-bus";

export const ACTIVE_STATUSES = ["SCHEDULED", "CONFIRMED", "IN_SERVICE"] as const;

export type AppointmentStatus =
  | "SCHEDULED"
  | "CONFIRMED"
  | "IN_SERVICE"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "RESCHEDULED";

/** Transições válidas de status. */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  SCHEDULED: ["CONFIRMED", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
  CONFIRMED: ["IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
  IN_SERVICE: ["COMPLETED", "NO_SHOW"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  RESCHEDULED: [],
};

export class BusinessError extends Error {}

export function assertTransition(from: string, to: string) {
  const allowed = TRANSITIONS[from as AppointmentStatus];
  if (!allowed || !allowed.includes(to as AppointmentStatus)) {
    throw new BusinessError(`Transição de status inválida: ${from} → ${to}.`);
  }
}

type TxLike = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function logAudit(
  tx: TxLike,
  data: { orgId: string; userId?: string; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }
) {
  await tx.auditLog.create({
    data: {
      orgId: data.orgId,
      userId: data.userId,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId,
      before: data.before !== undefined ? JSON.stringify(data.before) : undefined,
      after: data.after !== undefined ? JSON.stringify(data.after) : undefined,
    },
  });
}

export async function createAppointment(opts: {
  orgId: string;
  userId?: string;
  barberId: string;
  customerId: string;
  serviceId: string;
  startAt: Date;
  source?: string;
  notes?: string;
}) {
  const service = await db.service.findFirst({
    where: { id: opts.serviceId, orgId: opts.orgId, active: true },
  });
  if (!service) throw new BusinessError("Serviço não encontrado ou inativo.");

  const barber = await db.barber.findFirst({ where: { id: opts.barberId, orgId: opts.orgId, active: true } });
  if (!barber) throw new BusinessError("Barbeiro não encontrado ou inativo.");

  const customer = await db.customer.findFirst({ where: { id: opts.customerId, orgId: opts.orgId } });
  if (!customer) throw new BusinessError("Cliente não encontrado.");

  const endAt = new Date(opts.startAt.getTime() + service.durationMin * 60000);

  await assertSlotFree({
    orgId: opts.orgId,
    barberId: opts.barberId,
    startAt: opts.startAt,
    endAt,
  });

  const appointment = await db.$transaction(async (tx) => {
    const appt = await tx.appointment.create({
      data: {
        orgId: opts.orgId,
        barberId: opts.barberId,
        customerId: opts.customerId,
        serviceId: opts.serviceId,
        startAt: opts.startAt,
        endAt,
        status: "SCHEDULED",
        priceCents: service.priceCents,
        source: opts.source ?? "ADMIN",
        notes: opts.notes,
        createdByUserId: opts.userId,
      },
    });
    await tx.appointmentStatusHistory.create({
      data: { appointmentId: appt.id, toStatus: "SCHEDULED", byUserId: opts.userId },
    });
    await logAudit(tx, {
      orgId: opts.orgId,
      userId: opts.userId,
      action: "appointment.create",
      entity: "appointment",
      entityId: appt.id,
      after: { startAt: opts.startAt.toISOString(), barberId: opts.barberId, customerId: opts.customerId },
    });
    return appt;
  });

  // O cliente que estava sem próximo horário ganhou um: a oportunidade "Sem agendamento
  // futuro" deixa de valer na hora, sem esperar o próximo ciclo de detecção. Falha aqui não
  // pode derrubar o agendamento — é efeito colateral de leitura, não parte da transação.
  await db.opportunity
    .updateMany({
      where: { orgId: opts.orgId, type: "NO_UPCOMING", status: "OPEN", refId: opts.customerId },
      data: { status: "ACTION_TAKEN", resolvedAt: new Date() },
    })
    .catch(() => {});

  await publishEvent(opts.orgId, "appointment.created", {
    appointmentId: appointment.id,
    customerId: opts.customerId,
    startAt: appointment.startAt,
  });

  // Sincroniza o status da conversa do WhatsApp para "Aberta" (OPEN)
  await syncWhatsAppConversationStatus(opts.orgId, appointment.id, appointment.status as AppointmentStatus);

  // O par fixo do menu ("Mensagem de agendamento") já decidiu o envio acima, em publishEvent:
  // mesmo dia → confirmação; próximo dia ou mais → lembrete de 24h. O envio direto abaixo é só
  // para clínicas antigas, que ainda não têm a regra provisionada — e, mesmo nesse caso, ele
  // respeita o interruptor: se a regra existe e está desligada, o cliente não recebe nada.
  if (isBusinessSameDay(appointment.startAt)) {
    const creationRules = await db.automationRule.findMany({
      where: { orgId: opts.orgId, event: "appointment.created" },
      select: { action: true, config: true },
    });
    const hasConfirmationRule = creationRules.some(
      (rule) => rule.action === "send_whatsapp" && ruleTemplate(rule.config) === "confirmation"
    );

    if (!hasConfirmationRule) {
      try {
        await sendTemplateMessage({
          orgId: opts.orgId,
          templateKey: "confirmation",
          vars: {
            appointmentId: appointment.id,
            customerId: customer.id,
            phone: customer.phone,
            customerName: customer.name,
            serviceName: service.name,
            barberName: barber.name,
            startAt: appointment.startAt,
          },
        });
      } catch (err) {
        console.error("[createAppointment] Erro ao enviar confirmação do mesmo dia:", err);
      }
    }
  }

  publishAppointmentEvent({
    type: "appointment.created",
    orgId: opts.orgId,
    appointmentId: appointment.id,
    status: appointment.status,
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    barberId: appointment.barberId,
    customerId: appointment.customerId,
    at: new Date().toISOString(),
  });

  return appointment;
}

export async function rescheduleAppointment(opts: {
  orgId: string;
  userId?: string;
  appointmentId: string;
  newStartAt: Date;
  newBarberId?: string;
}) {
  const current = await db.appointment.findFirst({
    where: { id: opts.appointmentId, orgId: opts.orgId },
    include: { service: true },
  });
  if (!current) throw new BusinessError("Agendamento não encontrado.");
  if (!["SCHEDULED", "CONFIRMED"].includes(current.status)) {
    throw new BusinessError("Somente agendamentos agendados ou confirmados podem ser remarcados.");
  }

  const barberId = opts.newBarberId ?? current.barberId;
  const endAt = new Date(opts.newStartAt.getTime() + current.service.durationMin * 60000);

  if (barberId !== current.barberId) {
    const barber = await db.barber.findFirst({ where: { id: barberId, orgId: opts.orgId, active: true } });
    if (!barber) throw new BusinessError("Barbeiro não encontrado ou inativo.");
  }

  await assertSlotFree({
    orgId: opts.orgId,
    barberId,
    startAt: opts.newStartAt,
    endAt,
    ignoreAppointmentId: current.id,
  });

  const updated = await db.$transaction(async (tx) => {
    const appt = await tx.appointment.update({
      where: { id: current.id },
      data: {
        startAt: opts.newStartAt,
        endAt,
        barberId,
        status: "SCHEDULED",
      },
    });
    await tx.appointmentStatusHistory.create({
      data: {
        appointmentId: current.id,
        fromStatus: current.status,
        toStatus: "SCHEDULED",
        byUserId: opts.userId,
        reason: "Remarcado",
      },
    });
    await logAudit(tx, {
      orgId: opts.orgId,
      userId: opts.userId,
      action: "appointment.reschedule",
      entity: "appointment",
      entityId: current.id,
      before: { startAt: current.startAt.toISOString(), barberId: current.barberId },
      after: { startAt: opts.newStartAt.toISOString(), barberId },
    });
    return appt;
  });

  // Mensagens pendentes do horário antigo não devem mais ser enviadas — por isso esta varredura
  // vem ANTES do publishEvent. Depois do evento a fila já tem o aviso de remarcação e os
  // lembretes do horário novo, e um `updateMany` em tudo que está QUEUED cancelava exatamente o
  // que acabou de ser criado (o cliente não recebia nem a remarcação nem o lembrete novo).
  await db.whatsAppMessage.updateMany({
    where: { appointmentId: current.id, status: "QUEUED" },
    data: { status: "CANCELLED", error: "Agendado remarcado antes do envio." },
  });

  await publishEvent(opts.orgId, "appointment.rescheduled", {
    appointmentId: current.id,
    customerId: current.customerId,
    startAt: opts.newStartAt,
    previousStartAt: current.startAt,
  });

  publishAppointmentEvent({
    type: "appointment.updated",
    orgId: opts.orgId,
    appointmentId: current.id,
    status: "SCHEDULED",
    startAt: opts.newStartAt.toISOString(),
    endAt: endAt.toISOString(),
    barberId,
    customerId: current.customerId,
    at: new Date().toISOString(),
  });

  return updated;
}

export async function changeStatus(opts: {
  orgId: string;
  userId?: string | null;
  appointmentId: string;
  to: AppointmentStatus;
  reason?: string;
}) {
  const current = await db.appointment.findFirst({
    where: { id: opts.appointmentId, orgId: opts.orgId },
  });
  if (!current) throw new BusinessError("Agendamento não encontrado.");
  assertTransition(current.status, opts.to);

  const updated = await db.$transaction(async (tx) => {
    const appt = await tx.appointment.update({
      where: { id: current.id },
      data: { status: opts.to },
    });

    // Concluir NÃO registra recebimento sozinho. O caixa é decidido na Agenda, pelo botão
    // de status do recebimento do atendimento concluído — assim a forma (Dinheiro/PIX/Cartão)
    // é escolhida por quem recebeu, e não cair tudo como Dinheiro por padrão.

    await tx.appointmentStatusHistory.create({
      data: {
        appointmentId: current.id,
        fromStatus: current.status,
        toStatus: opts.to,
        byUserId: opts.userId,
        reason: opts.reason,
      },
    });
    await logAudit(tx, {
      orgId: opts.orgId,
      userId: opts.userId ?? undefined,
      action: `appointment.${opts.to.toLowerCase()}`,
      entity: "appointment",
      entityId: current.id,
      before: { status: current.status },
      after: { status: opts.to },
    });
    return appt;
  });

  // Eventos de domínio → automações (mensagens, notificações, oportunidades)
  const eventByStatus: Partial<Record<AppointmentStatus, Parameters<typeof publishEvent>[1]>> = {
    CONFIRMED: "appointment.confirmed",
    CANCELLED: "appointment.cancelled",
    COMPLETED: "appointment.completed",
    NO_SHOW: "appointment.no_show",
  };
  const domainEvent = eventByStatus[opts.to];
  if (domainEvent) {
    await publishEvent(opts.orgId, domainEvent, {
      appointmentId: current.id,
      customerId: current.customerId,
      startAt: current.startAt,
    });
  }

  // Notifica telas da Agenda abertas em tempo real
  publishAppointmentEvent({
    type: "appointment.updated",
    orgId: opts.orgId,
    appointmentId: current.id,
    status: opts.to,
    startAt: current.startAt.toISOString(),
    endAt: current.endAt.toISOString(),
    barberId: current.barberId,
    customerId: current.customerId,
    at: new Date().toISOString(),
  });

  // Sincroniza status da conversa do WhatsApp quando o agendamento muda
  await syncWhatsAppConversationStatus(opts.orgId, current.id, opts.to);

  // Recalcula métricas do cliente quando o histórico muda
  if (["COMPLETED", "NO_SHOW", "CANCELLED"].includes(opts.to)) {
    await enqueueJob({
      type: "compute_metrics",
      payload: { orgId: opts.orgId, customerId: current.customerId },
      dedupeKey: `metrics:${current.customerId}`,
    });
  }

  // Disparo imediato da mensagem pós-atendimento para o WhatsApp do cliente cadastrado
  let whatsappOutcome: { sent: boolean; status?: string; error?: string; friendly?: string } | null = null;
  if (opts.to === "COMPLETED") {
    try {
      const customer = await db.customer.findFirst({
        where: { id: current.customerId, orgId: opts.orgId },
        select: { id: true, name: true, phone: true, whatsappOptIn: true },
      });

      if (customer?.phone && customer.whatsappOptIn !== false) {
        const template = await db.messageTemplate.findUnique({
          where: { orgId_key: { orgId: opts.orgId, key: "post_visit" } },
        });

        if (!template || template.enabled) {
          // A regra "Atendimento concluído → Agendar lembrete (Pós-atendimento)" já deixou
          // esta mensagem na fila (30 min depois) em publishEvent. Mandar o imediato também
          // fazia o cliente receber dois agradecimentos pelo mesmo atendimento — o aviso sai
          // uma única vez. Sem a regra (clínica antiga), o imediato continua sendo o único.
          const jaNaFila = await db.whatsAppMessage.findFirst({
            where: {
              orgId: opts.orgId,
              appointmentId: current.id,
              templateKey: "post_visit",
              status: { notIn: ["CANCELLED", "FAILED"] },
            },
            select: { id: true },
          });

          if (!jaNaFila) {
            const body =
              template?.body ||
              "Olá, {{cliente}}! Obrigado pela visita na {{barbearia}}! Esperamos você novamente. Se puder, deixe sua avaliação. ✨";

            const { sendMessage } = await import("@/modules/whatsapp/service");
            const outcome = await sendMessage({
              orgId: opts.orgId,
              phone: customer.phone,
              customerId: customer.id,
              appointmentId: current.id,
              body,
              templateKey: "post_visit",
              userId: opts.userId,
              immediate: true,
            });

            whatsappOutcome = {
              sent: outcome.ok,
              status: outcome.status,
              error: outcome.error,
              friendly: outcome.friendly,
            };
          }
        }
      }
    } catch (err) {
      console.error("[changeStatus] Erro ao disparar WhatsApp pós-atendimento:", err);
      whatsappOutcome = {
        sent: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Cancelou: o que estava na fila para este horário não pode mais sair. Sem isto o cliente
  // recebia o lembrete de 24h/2h de um horário que a clínica já tinha cancelado (o
  // cancelamento em si é enviado logo abaixo).
  //
  // O pós-atendimento entra na mesma varredura, com motivo próprio: a regra "Atendimento
  // concluído → Agendar lembrete (Pós-atendimento)" o deixa 30 min na fila, e cancelar dentro
  // desse intervalo mandava um "obrigado pela visita" para quem não foi atendido.
  if (["CANCELLED", "NO_SHOW"].includes(opts.to)) {
    const faltou = opts.to === "NO_SHOW";
    const cancelados = await db.whatsAppMessage.updateMany({
      where: {
        orgId: opts.orgId,
        appointmentId: current.id,
        status: "QUEUED",
        templateKey: { in: ["reminder_24h", "reminder_2h", "confirmation"] },
      },
      data: {
        status: "CANCELLED",
        error: faltou
          ? "Cliente marcado como falta: o lembrete não será mais enviado."
          : "Agendamento cancelado: o lembrete não será mais enviado.",
      },
    });
    const posAtendimento = await db.whatsAppMessage.updateMany({
      where: {
        orgId: opts.orgId,
        appointmentId: current.id,
        status: "QUEUED",
        templateKey: "post_visit",
      },
      data: {
        status: "CANCELLED",
        error: faltou
          ? "Cliente marcado como falta: a mensagem pós-atendimento não será enviada."
          : "Agendamento cancelado: a mensagem pós-atendimento não será enviada.",
      },
    });
    if (cancelados.count > 0) {
      console.log(`[changeStatus] ${cancelados.count} mensagem(ns) pendente(s) cancelada(s) — ${opts.to}`);
    }
    if (posAtendimento.count > 0) {
      console.log(`[changeStatus] ${posAtendimento.count} mensagem(ns) pós-atendimento cancelada(s) — ${opts.to}`);
    }
  }

  // Disparo imediato do template de cancelamento para o WhatsApp do cliente cadastrado
  if (opts.to === "CANCELLED") {
    try {
      const customer = await db.customer.findFirst({
        where: { id: current.customerId, orgId: opts.orgId },
        select: { id: true, name: true, phone: true, whatsappOptIn: true },
      });

      if (customer?.phone && customer.whatsappOptIn !== false) {
        const sent = await sendTemplateMessage({
          orgId: opts.orgId,
          templateKey: "cancellation",
          vars: {
            appointmentId: current.id,
            customerId: customer.id,
            phone: customer.phone,
            customerName: customer.name,
            startAt: current.startAt,
          },
          dedupeKey: `cancellation:${current.id}`,
        });

        whatsappOutcome = {
          sent,
          status: sent ? "QUEUED" : undefined,
        };
      }
    } catch (err) {
      console.error("[changeStatus] Erro ao disparar WhatsApp cancelamento:", err);
      whatsappOutcome = {
        sent: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Horário liberado → detector de oportunidades
  if (["CANCELLED", "NO_SHOW"].includes(opts.to)) {
    await publishEvent(opts.orgId, "slot.opened", {
      slot: {
        date: current.startAt.toISOString().slice(0, 10),
        time: current.startAt.toTimeString().slice(0, 5),
        barberId: current.barberId,
      },
      appointmentId: current.id,
    });
    await enqueueJob({
      type: "detect_opportunities",
      payload: { orgId: opts.orgId },
      dedupeKey: `detect:${opts.orgId}`,
    });
  }

  return Object.assign(updated, { whatsapp: whatsappOutcome });
}

/**
 * Sincroniza o status da conversa do WhatsApp com o status do agendamento.
 *
 * É aqui que o "Novo agendamento" da Agenda vira um chat ABERTA no painel do WhatsApp:
 *  - a conversa é procurada pelo cliente NA conversa e também pelo cliente do CONTATO
 *    (o vínculo costuma estar só na ficha, e era por isso que o agendamento não aparecia);
 *  - se o cliente tem telefone mas nenhuma conversa, a ficha/conversa é criada na hora —
 *    sem isso, o painel só mostraria o agendamento de quem já tinha trocado mensagem;
 *  - todas as conversas do cliente recebem o status: com fichas duplicadas, atualizar só a
 *    primeira fazia o badge voltar ao valor antigo depois de recarregar a tela.
 */
export async function syncWhatsAppConversationStatus(
  orgId: string,
  appointmentId: string,
  newStatus: AppointmentStatus
) {
  const appointment = await db.appointment.findFirst({
    where: { id: appointmentId, orgId },
    select: {
      customerId: true,
      startAt: true,
      service: { select: { name: true } },
      barber: { select: { name: true } },
    },
  });
  if (!appointment) return;

  const statusMap: Record<AppointmentStatus, string> = {
    SCHEDULED: "OPEN",
    CONFIRMED: "OPEN",
    IN_SERVICE: "IN_PROGRESS",
    COMPLETED: "DONE",
    CANCELLED: "DONE",
    NO_SHOW: "DONE",
    RESCHEDULED: "OPEN",
  };

  const targetStatus = statusMap[newStatus];
  if (!targetStatus) return;

  const customer = await db.customer.findFirst({
    where: { id: appointment.customerId, orgId },
    select: { id: true, name: true, phone: true },
  });
  if (!customer) return;

  const { publish } = await import("@/modules/whatsapp/bus");

  let conversations = await db.whatsAppConversation.findMany({
    where: {
      orgId,
      OR: [{ customerId: customer.id }, { contact: { customerId: customer.id } }],
    },
    select: { id: true, status: true, customerId: true, _count: { select: { messages: true } } },
  });

  // Cliente do CRM sem conversa no WhatsApp: criamos pelo telefone para o agendamento
  // aparecer no painel. Só na abertura — cancelar/CONCLUIR um cliente que nunca falou no
  // WhatsApp não pode fabricar uma conversa "Concluída" do nada. Sem telefone discável
  // também não dá para inventar um chat.
  if (conversations.length === 0 && targetStatus === "OPEN") {
    try {
      const { ensureConversationForTarget } = await import("@/modules/whatsapp/ingest");
      const { toWhatsAppDigits } = await import("@/lib/phone");
      const digits = toWhatsAppDigits(customer.phone);
      if (digits) {
        const { conversation } = await ensureConversationForTarget({
          orgId,
          jid: `${digits}@s.whatsapp.net`,
          phone: digits,
          name: customer.name,
          customerId: customer.id,
        });
        conversations = [
          { id: conversation.id, status: conversation.status, customerId: conversation.customerId, _count: { messages: 0 } },
        ];
      }
    } catch (err) {
      console.error("[agenda] não foi possível abrir a conversa do WhatsApp para o agendamento", err);
    }
  }

  for (const conversation of conversations) {
    // Amarra o cliente na conversa que só tinha o vínculo pelo contato: os filtros
    // ("Agendamentos", "Concluído") e a próxima sincronização dependem desse campo.
    if (!conversation.customerId) {
      await db.whatsAppConversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
    }

    // Pré-visualização de uma conversa recém-criada pelo agendamento: a linha da lista não
    // pode chegar vazia. Só quando ainda não existe mensagem, para nunca sobrescrever um papo.
    if (conversation._count.messages === 0) {
      const { data, hora } = formatDateTimeBR(appointment.startAt);
      const when = `${data} às ${hora}`;
      await db.whatsAppConversation.update({
        where: { id: conversation.id },
        data: {
          lastBody: `Agendamento: ${when} · ${appointment.service.name}${appointment.barber?.name ? ` com ${appointment.barber.name}` : ""}`,
          lastMessageAt: appointment.startAt,
        },
      });
    }

    if (conversation.status !== targetStatus) {
      await db.whatsAppConversation.update({ where: { id: conversation.id }, data: { status: targetStatus } });
      publish({ type: "conversation.changed", orgId, conversationId: conversation.id });
    }
  }
}
