/**
 * Vocabulário do "par fixo" de mensagens do agendamento, compartilhado entre o motor de
 * eventos, a API do menu e a criação do agendamento.
 *
 * A tela de Automações mostra as duas regras como um único interruptor ("Mensagem de
 * agendamento"), mas no banco elas continuam separadas — é o que permite o motor escolher
 * pelo dia do horário, sem inventar um tipo novo de regra:
 *   - mesmo dia          → `send_whatsapp` (confirmation);
 *   - próximo dia ou mais → `schedule_reminder` (reminder_24h), 24h antes.
 *
 * O `config` da regra é JSON em texto no banco, mas a API devolve o objeto já parseado para a
 * tela. Por isso as funções abaixo aceitam as duas formas.
 */

export const NOTICE_EVENT = "appointment.created";

export function ruleTemplate(
  config: string | { template?: unknown } | null | undefined
): string | null {
  if (!config) return null;
  if (typeof config === "object") {
    return typeof config.template === "string" ? config.template : null;
  }
  try {
    const parsed = JSON.parse(config) as { template?: unknown };
    return typeof parsed.template === "string" ? parsed.template : null;
  } catch {
    return null;
  }
}

/** `true` para as duas regras que o interruptor do menu controla em conjunto. */
export function isFixedNoticeRule(rule: {
  event: string;
  action: string;
  config: string | { template?: unknown } | null | undefined;
}): boolean {
  if (rule.event !== NOTICE_EVENT) return false;
  const template = ruleTemplate(rule.config);
  if (rule.action === "send_whatsapp" && template === "confirmation") return true;
  if (rule.action === "schedule_reminder" && template === "reminder_24h") return true;
  return false;
}

/**
 * Regra legada: o lembrete de 24h que ficava preso em "Agendamento confirmado". O par fixo
 * já agenda o lembrete na criação; se esta regra continuar ligada, desligar o interruptor do
 * menu não calaria o cliente — confirmar o horário dispararia um lembrete por fora.
 */
export function isLegacyConfirmedReminder(rule: {
  event: string;
  action: string;
  config: string | { template?: unknown } | null | undefined;
}): boolean {
  return (
    rule.event === "appointment.confirmed" &&
    rule.action === "schedule_reminder" &&
    ruleTemplate(rule.config) === "reminder_24h"
  );
}
