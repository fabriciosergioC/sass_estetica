// Motor de eventos: publica eventos do domínio e executa as regras de automação
// da organização. Ações são resolvidas aqui; efeitos demorados viram jobs.
import { db } from "@/lib/db";
import { isBusinessSameDay } from "@/lib/datetime";
import { enqueueJob } from "./jobs";
import { sendTemplateMessage, type TemplateKey } from "@/modules/whatsapp/messages";

export const DOMAIN_EVENTS = [
  "appointment.created",
  "appointment.confirmed",
  "appointment.cancelled",
  "appointment.rescheduled",
  "appointment.completed",
  "appointment.no_show",
  "customer.created",
  "customer.inactive",
  "customer.return_due",
  "slot.opened",
] as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

export type EventPayload = {
  appointmentId?: string;
  customerId?: string;
  startAt?: Date;
  previousStartAt?: Date;
  barberId?: string;
  serviceId?: string;
  /** slot.opened */
  slot?: { date: string; time: string; barberId: string };
  [key: string]: unknown;
};

type RuleConfig = {
  template?: TemplateKey;
  hoursBefore?: number;
  delayMinutes?: number;
  title?: string;
  body?: string;
};

export type DecisaoLembrete = { runAt: Date | null; motivo: string };

/**
 * Decide QUANDO um `schedule_reminder` deve sair — ou se ele não deve sair.
 *
 * Separado da função de evento porque foi aqui que o bug de 2026-11-03 morava: o código antigo
 * "recuperava" um lembrete cujo momento já passou mandando-o na hora. Isso servia para o horário
 * do DIA SEGUINTE (agendou hoje à noite para amanhã de manhã: "é amanhã, {{data}}" continua
 * verdade e o aviso faz falta) e quebrava para o horário do MESMO DIA — o cliente recebia,
 * segundos depois da confirmação, um "Lembrete: é amanhã, 03/11 às 12:00" de um horário que é
 * hoje. Então a pergunta certa não é "atrasou?", é "ainda faz sentido avisar?".
 *
 * Regras:
 *  - sem `hoursBefore`: é uma regra por atraso (ex: pós-atendimento 30 min depois) → sempre sai;
 *  - `runAt` no futuro: sai na antecedência pedida;
 *  - `runAt` no passado e o horário é em OUTRO dia: sai agora (o aviso ainda vale);
 *  - `runAt` no passado e o horário é HOJE (ou já passou): não sai — a confirmação já trouxe
 *    data e hora, e para avisar em cima da hora existe `reminder_2h`, que calcula runAt no futuro.
 */
export function decisaoLembrete(
  cfg: { hoursBefore?: number; delayMinutes?: number },
  startAt: Date | undefined,
  agora: Date = new Date()
): DecisaoLembrete {
  const delay = cfg.delayMinutes ?? 0;

  if (cfg.hoursBefore === undefined || !startAt) {
    return {
      runAt: new Date(agora.getTime() + delay * 60_000),
      motivo: delay ? `dispara ${delay} min depois do evento` : "dispara na hora",
    };
  }

  const runAt = new Date(startAt.getTime() - cfg.hoursBefore * 3_600_000 - delay * 60_000);
  if (runAt.getTime() > agora.getTime()) {
    return { runAt, motivo: `dispara ${cfg.hoursBefore} h antes, no momento certo` };
  }

  const faltam = Math.round((startAt.getTime() - agora.getTime()) / 60_000);
  if (startAt.getTime() <= agora.getTime()) {
    return { runAt: null, motivo: `o horário já passou (${Math.abs(faltam)} min atrás) — nada enviado` };
  }
  if (startAt.toDateString() === agora.toDateString()) {
    return {
      runAt: null,
      motivo: `o horário é hoje (faltam ${faltam} min): um lembrete de ${cfg.hoursBefore} h não tem como existir — nada enviado`,
    };
  }
  return {
    runAt: agora,
    motivo: `a marca de ${cfg.hoursBefore} h já passou, mas o horário é em outro dia (faltam ${faltam} min) — o aviso ainda vale, dispara agora`,
  };
}

/** Busca dados do agendamento para montar as variáveis dos templates. */
async function appointmentVars(orgId: string, appointmentId?: string) {
  if (!appointmentId) return {};
  const appt = await db.appointment.findFirst({
    where: { id: appointmentId, orgId },
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      barber: { select: { name: true } },
      service: { select: { name: true, durationMin: true } },
    },
  });
  if (!appt) return {};
  return {
    appointmentId: appt.id,
    customerId: appt.customer.id,
    phone: appt.customer.phone,
    customerName: appt.customer.name,
    serviceName: appt.service.name,
    barberName: appt.barber.name,
    startAt: appt.startAt,
  };
}

/**
 * Publica um evento e dispara as regras habilitadas da organização.
 * Nunca lança: falha de automação não pode quebrar a operação principal.
 */
export async function publishEvent(
  orgId: string,
  event: DomainEvent,
  payload: EventPayload = {}
): Promise<void> {
  try {
    const rules = await db.automationRule.findMany({
      where: { orgId, event, enabled: true },
    });
    if (rules.length === 0) return;

    const vars = await appointmentVars(orgId, payload.appointmentId);

    // Remarcar muda o horário, então o lembrete que estava na fila vale para uma hora que não
    // existe mais. Cancelamos aqui (o job correspondente vira no-op porque `handleSendWhatsapp`
    // só age em mensagem QUEUED) para as regras deste mesmo evento reagendarem no horário novo.
    // Sem isto, o cliente recebia o lembrete na hora antiga e nada na nova.
    if (event === "appointment.rescheduled" && payload.appointmentId) {
      const cancelados = await db.whatsAppMessage.updateMany({
        where: {
          orgId,
          appointmentId: payload.appointmentId,
          status: "QUEUED",
          templateKey: { in: ["reminder_24h", "reminder_2h"] },
        },
        data: { status: "CANCELLED", error: "Agendamento remarcado: o lembrete foi reagendado no horário novo." },
      });
      if (cancelados.count > 0) {
        console.log(`[events] ${cancelados.count} lembrete(s) pendente(s) cancelado(s) por remarcação`);
      }
    }

    for (const rule of rules) {
      const config = JSON.parse(rule.config || "{}") as RuleConfig;
      const execution = await db.automationExecution.create({
        data: { orgId, ruleId: rule.id, event, payload: JSON.stringify(payload), status: "RUNNING" },
      });

      try {
        switch (rule.action) {
          case "send_whatsapp": {
            if (!config.template) throw new Error("Regra sem template configurado.");

            // Política de mensagens da clínica (2026-11-08):
            //  - horário HOJE  → só a confirmação (enviada na criação, em createAppointment);
            //  - horário em OUTRO dia → só o lembrete de 24h (regra `schedule_reminder`).
            // Regras antigas de `confirmation` em `appointment.created` mandavam a
            // confirmação para qualquer data — era a mensagem duplicada junto do lembrete.
            const startAt = vars.startAt as Date | undefined;
            if (config.template === "confirmation" && startAt && !isBusinessSameDay(startAt)) {
              await db.automationExecution.update({
                where: { id: execution.id },
                data: {
                  status: "SKIPPED",
                  error: "confirmation: horário em outro dia — para dias posteriores sai só o lembrete de 24h.",
                },
              });
              console.log(`[events] ${event} → confirmation: pulado (horário não é hoje)`);
              continue;
            }

            await sendTemplateMessage({
              orgId,
              templateKey: config.template,
              vars,
              dedupeKey: `${event}:${rule.id}:${payload.appointmentId ?? payload.customerId ?? "n/a"}`,
            });
            break;
          }
          case "schedule_reminder": {
            if (!config.template) break;
            const startAt = vars.startAt as Date | undefined;
            const decisao = decisaoLembrete(config, startAt);

            if (!decisao.runAt) {
              await db.automationExecution.update({
                where: { id: execution.id },
                data: { status: "SKIPPED", error: `${config.template}: ${decisao.motivo}` },
              });
              console.log(`[events] ${event} → ${config.template}: pulado (${decisao.motivo})`);
              continue;
            }

            await sendTemplateMessage({
              orgId,
              templateKey: config.template,
              vars,
              dedupeKey: `${event}:${rule.id}:${payload.appointmentId}:${config.hoursBefore ?? "delay"}`,
              runAt: decisao.runAt,
            });
            break;
          }
          case "notify_admin": {
            await enqueueJob({
              type: "notify_admin",
              payload: {
                orgId,
                notification: {
                  type: `AUTOMATION_${event.toUpperCase().replace(/\./g, "_")}`,
                  title: config.title ?? "Evento na agenda",
                  body: config.body ?? event,
                },
              },
            });
            break;
          }
          case "create_opportunity": {
            // marcador para o detector de oportunidades processar este evento
            await enqueueJob({
              type: "detect_opportunities",
              payload: { orgId },
              dedupeKey: `detect:${orgId}`,
            });
            break;
          }
          case "create_task":
          case "update_customer":
            // reservado para futuras ações; registrada como não implementada
            break;
          default:
            throw new Error(`Ação desconhecida: ${rule.action}`);
        }

        await db.automationExecution.update({
          where: { id: execution.id },
          data: { status: "SUCCESS" },
        });
      } catch (err) {
        await db.automationExecution.update({
          where: { id: execution.id },
          data: { status: "FAILED", error: err instanceof Error ? err.message : String(err) },
        });
        await db.notification
          .create({
            data: {
              orgId,
              type: "AUTOMATION_ERROR",
              title: "Falha em automação",
              body: `${event} → ${rule.action}: ${err instanceof Error ? err.message : "erro"}`.slice(0, 300),
            },
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error("[events]", orgId, event, err);
  }
}
