import { db } from "@/lib/db";
import { containsCI } from "@/lib/search";
import { enqueueJob } from "@/modules/automation/jobs";
import { logWa } from "./logs";
import { publish } from "./bus";

/**
 * Respostas rápidas (§21), etiquetas (§22), follow-up (§23), trilha de logs (§24) e lista
 * de bloqueio (§25). Coisas de atendimento, não de conexão: nada aqui toca o adapter.
 */

// ─── Respostas rápidas ─────────────────────────────────────────────────────

export async function listQuickReplies(orgId: string, search?: string) {
  const q = search?.trim();
  return db.whatsAppQuickReply.findMany({
    where: {
      orgId,
      ...(q ? { OR: [{ shortcut: containsCI(q) }, { title: containsCI(q) }, { body: containsCI(q) }] } : {}),
    },
    orderBy: { shortcut: "asc" },
  });
}

function normalizeShortcut(raw: string) {
  return raw.replace(/^\/+/, "").trim().toLowerCase();
}

export async function upsertQuickReply(opts: {
  orgId: string;
  shortcut: string;
  body: string;
  title?: string | null;
  id?: string | null;
}) {
  const shortcut = normalizeShortcut(opts.shortcut);
  if (!shortcut) throw new Error("Atalho obrigatório (ex.: ola).");
  if (!opts.body.trim()) throw new Error("Escreva o texto da resposta.");

  if (opts.id) {
    const owned = await db.whatsAppQuickReply.findFirst({ where: { id: opts.id, orgId: opts.orgId } });
    if (!owned) throw new Error("Resposta rápida não pertence a esta clínica.");
    return db.whatsAppQuickReply.update({
      where: { id: opts.id },
      data: { shortcut, body: opts.body, title: opts.title ?? null },
    });
  }

  return db.whatsAppQuickReply.upsert({
    where: { orgId_shortcut: { orgId: opts.orgId, shortcut } },
    update: { body: opts.body, title: opts.title ?? null },
    create: { orgId: opts.orgId, shortcut, body: opts.body, title: opts.title ?? null },
  });
}

export async function deleteQuickReply(orgId: string, id: string) {
  const deleted = await db.whatsAppQuickReply.deleteMany({ where: { id, orgId } });
  return deleted.count > 0;
}

/**
 * Expande o atalho digitado na caixa de mensagem (§7): se o texto começa com `/ola`,
 * substitui pelo corpo salvo. Retorna o texto final e o atalho usado.
 */
export async function expandShortcut(orgId: string, text: string): Promise<{ body: string; shortcut: string | null }> {
  const match = /^\s*\/(\w[\w-]*)\b/.exec(text);
  if (!match) return { body: text, shortcut: null };

  const reply = await db.whatsAppQuickReply.findFirst({ where: { orgId, shortcut: match[1].toLowerCase() } });
  if (!reply) return { body: text, shortcut: null };

  const rest = text.slice(match[0].length).trim();
  return { body: rest ? `${reply.body}\n\n${rest}` : reply.body, shortcut: reply.shortcut };
}

// ─── Etiquetas ─────────────────────────────────────────────────────────────

/** Etiquetas padrão do §22; criamos por org, nunca globais (cada barbearia renomeia). */
export const DEFAULT_LABELS: { name: string; color: string }[] = [
  { name: "Novo lead", color: "blue" },
  { name: "Interessado", color: "gold" },
  { name: "Sem resposta", color: "amber" },
  { name: "Follow-up", color: "amber" },
  { name: "Cliente", color: "green" },
  { name: "Não interessado", color: "red" },
  { name: "Agendar reunião", color: "blue" },
];

export async function listLabels(orgId: string) {
  const rows = await db.whatsAppLabel.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  if (rows.length) return rows;

  // Criação preguiçosa: a primeira tela de etiquetas já mostra as sugestões do prompt.
  for (const label of DEFAULT_LABELS) {
    await db.whatsAppLabel.upsert({
      where: { orgId_name: { orgId, name: label.name } },
      update: {},
      create: { orgId, name: label.name, color: label.color },
    });
  }
  return db.whatsAppLabel.findMany({ where: { orgId }, orderBy: { name: "asc" } });
}

export async function createLabel(orgId: string, name: string, color = "neutral") {
  const clean = name.trim().slice(0, 40);
  if (!clean) throw new Error("Nome da etiqueta é obrigatório.");
  return db.whatsAppLabel.upsert({
    where: { orgId_name: { orgId, name: clean } },
    update: { color },
    create: { orgId, name: clean, color },
  });
}

export async function deleteLabel(orgId: string, id: string) {
  const deleted = await db.whatsAppLabel.deleteMany({ where: { id, orgId } });
  return deleted.count > 0;
}

/** Anexa/detacha etiqueta de uma conversa (a etiqueta aparece na lista E no cadastro §22). */
export async function toggleConversationLabel(orgId: string, conversationId: string, labelId: string, on: boolean) {
  const conversation = await db.whatsAppConversation.findFirst({ where: { id: conversationId, orgId } });
  const label = await db.whatsAppLabel.findFirst({ where: { id: labelId, orgId } });
  if (!conversation || !label) return null;

  if (on) {
    await db.whatsAppConversationLabel.upsert({
      where: { conversationId_labelId: { conversationId, labelId } },
      update: {},
      create: { conversationId, labelId },
    });
  } else {
    await db.whatsAppConversationLabel.deleteMany({ where: { conversationId, labelId } });
  }

  publish({ type: "conversation.changed", orgId, conversationId });
  await logWa({ orgId, event: "label.toggle", actor: label.name, status: on ? "on" : "off" });
  return { conversationId, labelId, on };
}

// ─── Follow-up (§23) ───────────────────────────────────────────────────────

export async function scheduleFollowUp(opts: {
  orgId: string;
  conversationId?: string | null;
  customerId?: string | null;
  assigneeId?: string | null;
  scheduledAt: Date;
  reason: string;
}) {
  if (!opts.reason.trim()) throw new Error("Informe o motivo do follow-up.");
  if (Number.isNaN(opts.scheduledAt.getTime())) throw new Error("Data do follow-up inválida.");

  const followUp = await db.whatsAppFollowUp.create({
    data: {
      orgId: opts.orgId,
      conversationId: opts.conversationId ?? null,
      customerId: opts.customerId ?? null,
      assigneeId: opts.assigneeId ?? null,
      scheduledAt: opts.scheduledAt,
      reason: opts.reason.trim().slice(0, 200),
    },
  });

  // O lembrete é um job comum: notifica o responsável na hora marcada (§23).
  await enqueueJob({
    type: "notify_admin",
    payload: {
      orgId: opts.orgId,
      notification: {
        type: "WHATSAPP_FOLLOWUP",
        title: "Follow-up do WhatsApp",
        body: `${opts.reason.trim().slice(0, 160)} — ${opts.scheduledAt.toLocaleString("pt-BR")}`,
      },
    },
    runAt: opts.scheduledAt,
    dedupeKey: `followup:${followUp.id}`,
  });

  if (opts.conversationId) {
    await db.whatsAppConversation.updateMany({
      where: { id: opts.conversationId, orgId: opts.orgId },
      data: { status: "WAITING_CUSTOMER" },
    });
    publish({ type: "conversation.changed", orgId: opts.orgId, conversationId: opts.conversationId });
  }

  await logWa({ orgId: opts.orgId, event: "followup.scheduled", detail: opts.reason });
  return followUp;
}

export async function listFollowUps(orgId: string, status: string | null = "PENDING") {
  return db.whatsAppFollowUp.findMany({
    where: { orgId, ...(status && status !== "all" ? { status } : {}) },
    orderBy: { scheduledAt: "asc" },
    take: 100,
    include: {
      conversation: { include: { contact: { select: { name: true, phone: true } } } },
      customer: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true } },
    },
  });
}

export async function completeFollowUp(orgId: string, id: string, status: "DONE" | "CANCELLED" = "DONE") {
  const updated = await db.whatsAppFollowUp.updateMany({
    where: { id, orgId },
    data: { status, doneAt: status === "DONE" ? new Date() : null },
  });
  if (updated.count) await logWa({ orgId, event: `followup.${status.toLowerCase()}`, actor: id });
  return updated.count > 0;
}

// ─── Logs (§24) ────────────────────────────────────────────────────────────

export async function listLogs(orgId: string, opts: { level?: string; search?: string; take?: number; skip?: number } = {}) {
  const where: Record<string, unknown> = { orgId };
  if (opts.level) where.level = opts.level;
  const q = opts.search?.trim();
  if (q) where.OR = [{ event: containsCI(q) }, { detail: containsCI(q) }, { actor: containsCI(q) }];

  const [rows, total] = await Promise.all([
    db.whatsAppLog.findMany({ where: where as any, orderBy: { createdAt: "desc" }, skip: opts.skip ?? 0, take: opts.take ?? 100 }),
    db.whatsAppLog.count({ where: where as any }),
  ]);
  return { items: rows, total };
}

// ─── Lista de bloqueio (§25) ───────────────────────────────────────────────

export async function listBlocked(orgId: string) {
  return db.whatsAppBlockedNumber.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export async function setOptOut(orgId: string, customerId: string, optIn: boolean) {
  const customer = await db.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true, phone: true } });
  if (!customer) return null;

  await db.customer.update({ where: { id: customer.id }, data: { whatsappOptIn: optIn } });

  const { blockNumber, unblockNumber } = await import("./queue");
  if (!optIn && customer.phone) await blockNumber(orgId, customer.phone, "opt_out");
  if (optIn && customer.phone) await unblockNumber(orgId, customer.phone);

  await logWa({ orgId, event: optIn ? "opt_in" : "opt_out", actor: customer.phone });
  return { customerId: customer.id, optIn };
}
