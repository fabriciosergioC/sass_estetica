// Envio de mensagens: renderiza template da org, grava WhatsAppMessage (QUEUED)
// e agenda job assíncrono. Nunca bloqueia a requisição HTTP.
import { db } from "@/lib/db";
import { queueSendMessage } from "./queue";

export type TemplateKey =
  | "confirmation"
  | "reminder_24h"
  | "reminder_2h"
  | "cancellation"
  | "reschedule"
  | "post_visit"
  | "return_due"
  | "slot_recovery";

export function renderTemplate(
  body: string,
  vars: Record<string, string | number | Date | null | undefined>
): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

export function formatDateTimeBR(d: Date): { data: string; hora: string } {
  return {
    data: d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }),
    hora: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
  };
}

export type AppointmentVars = {
  appointmentId?: string;
  customerId?: string;
  phone?: string;
  customerName?: string;
  serviceName?: string;
  barberName?: string;
  startAt?: Date;
};

/**
 * Envia um template para o cliente vinculado a um agendamento (ou telefone direto).
 * Respeita opt-out (whatsappOptIn) e mensagens por template desabilitado.
 * Retorna false quando nada foi agendado (sem opt-in, template inexistente, etc).
 */
export async function sendTemplateMessage(opts: {
  orgId: string;
  templateKey: TemplateKey;
  /** Dados do agendamento/cliente para preencher o template. */
  vars: AppointmentVars;
  /** Variáveis extras de template (ex: {{hora}} de um slot). */
  extra?: Record<string, string | number | null | undefined>;
  /** Garante no máximo 1 envio por chave/agendamento. */
  dedupeKey?: string;
  runAt?: Date;
}): Promise<boolean> {
  const { orgId, templateKey } = opts;

  const [template, org] = await Promise.all([
    db.messageTemplate.findUnique({ where: { orgId_key: { orgId, key: templateKey } } }),
    db.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
  ]);
  if (!template || !template.enabled) return false;

  const v = opts.vars;
  let phone = v.phone ?? null;
  let customerId = v.customerId ?? null;
  let customerName = v.customerName ?? null;
  let optIn = true;

  if (customerId) {
    const customer = await db.customer.findFirst({
      where: { id: customerId, orgId },
      select: { name: true, phone: true, whatsappOptIn: true },
    });
    if (!customer) return false;
    phone = customer.phone;
    customerName = customerName ?? customer.name;
    optIn = customer.whatsappOptIn;
  }
  if (!phone || !optIn) return false;

  if (v.appointmentId) {
    const existing = await db.whatsAppMessage.findFirst({
      where: { orgId, appointmentId: v.appointmentId, templateKey, status: { notIn: ["CANCELLED", "FAILED"] } },
    });
    if (existing) return false;
  }

  const { data, hora } = v.startAt ? formatDateTimeBR(v.startAt) : { data: "", hora: "" };
  const body = renderTemplate(template.body, {
    cliente: customerName ?? "",
    barbearia: org?.name ?? "",
    servico: v.serviceName ?? "",
    barbeiro: v.barberName ?? "",
    data,
    hora,
    ...opts.extra,
  });

  const message = await db.whatsAppMessage.create({
    data: {
      orgId,
      customerId,
      appointmentId: v.appointmentId,
      direction: "OUT",
      phone,
      body,
      templateKey,
      status: "QUEUED",
    },
  });

  // Mesmo espaçamento da fila de conversa (§26): template agendado sai na hora pedida,
  // template imediato sai depois do intervalo mínimo desde o último envio — assim uma
  // campanha disparada por automação vira uma escada, não um pico no socket.
  await queueSendMessage({ orgId, messageId: message.id, runAt: opts.runAt, dedupeKey: opts.dedupeKey });
  return true;
}
