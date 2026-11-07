import { db } from "@/lib/db";
import { enqueueJob } from "@/modules/automation/jobs";
import { logWa, redact } from "./logs";
import { publish } from "./bus";

/**
 * Fila de envio e proteções operacionais (§25, §26).
 *
 * O que este arquivo NÃO faz, de propósito: não acelera disparos em massa, não contorna
 * bloqueio, não finge identidade e não esconde automação da plataforma. Ele existe para o
 * contrário — mandar devagar, parar quando algo dá errado e nunca falar com número que não
 * consentiu. Numa API não-oficial, respeitar ritmo é também o que mantém a conta sã.
 *
 * Concorrência é 1 e não é configurável: dois envios simultâneos no mesmo socket geram
 * reordenação de ack e, na prática, foi o que tornou o diagnóstico de 27/10 confuso.
 */

const envNumber = (name: string, fallback: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export const QUEUE_LIMITS = {
  concurrency: 1,
  /** Intervalo mínimo entre dois envios da mesma barbearia. */
  intervalMs: envNumber("WHATSAPP_SEND_INTERVAL_MS", 3_000),
  /** Teto de saídas por hora — proteção contra disparo indiscriminado. */
  perHour: envNumber("WHATSAPP_SEND_MAX_PER_HOUR", 60),
  /** Falhas seguidas que pausam a fila. */
  pauseAfterFailures: envNumber("WHATSAPP_SEND_PAUSE_AFTER", 3),
  /** Duração da pausa automática. */
  pauseMinutes: envNumber("WHATSAPP_SEND_PAUSE_MINUTES", 15),
};

type PauseInfo = { paused: boolean; until: string | null; reason: string | null };

function pauseKey(orgId: string) {
  return `whatsapp.pause.${orgId}`;
}

/** A pausa sobrevive a restart: se o erro foi do WhatsApp, reabrir o app não deve reabrir a fila. */
export async function pauseInfo(orgId: string): Promise<PauseInfo> {
  const row = await db.systemSetting.findUnique({ where: { key: pauseKey(orgId) } });
  if (!row?.value) return { paused: false, until: null, reason: null };
  try {
    const parsed = JSON.parse(row.value) as PauseInfo;
    if (parsed.until && new Date(parsed.until).getTime() < Date.now()) {
      await db.systemSetting.delete({ where: { key: pauseKey(orgId) } }).catch(() => {});
      return { paused: false, until: null, reason: null };
    }
    return parsed;
  } catch {
    return { paused: false, until: null, reason: null };
  }
}

export async function pauseSending(orgId: string, reason: string, minutes = QUEUE_LIMITS.pauseMinutes): Promise<void> {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await db.systemSetting.upsert({
    where: { key: pauseKey(orgId) },
    update: { value: JSON.stringify({ paused: true, until, reason }) },
    create: { key: pauseKey(orgId), value: JSON.stringify({ paused: true, until, reason }) },
  });
  await logWa({ orgId, level: "warn", event: "queue.paused", detail: `${reason} até ${until}` });
}

export async function resumeSending(orgId: string, by?: string): Promise<void> {
  await db.systemSetting.delete({ where: { key: pauseKey(orgId) } }).catch(() => {});
  consecutiveFailures.delete(orgId);
  await logWa({ orgId, event: "queue.resumed", actor: by ?? null });
}

/** Contador em memória só do "seguidas" — o total histórico está nos Logs. */
const GLOBAL_KEY = "__whatsapp_queue_failures__" as const;
const consecutiveFailures = new Map<string, number>();

/** Registra o resultado de um envio; na N-ésima falha seguida, pausa a fila. */
export async function noteSendResult(orgId: string, ok: boolean, detail?: string | null): Promise<{ paused: boolean }> {
  if (ok) {
    consecutiveFailures.set(orgId, 0);
    return { paused: false };
  }
  const next = (consecutiveFailures.get(orgId) ?? 0) + 1;
  consecutiveFailures.set(orgId, next);
  if (next >= QUEUE_LIMITS.pauseAfterFailures) {
    await pauseSending(
      orgId,
      `${next} falhas seguidas de envio${detail ? ` (última: ${detail})` : ""}`
    );
    consecutiveFailures.set(orgId, 0);
    return { paused: true };
  }
  return { paused: false };
}

export type GuardResult = { ok: boolean; reason?: string };

/**
 * Pente-fino antes de qualquer saída (§25): pausa ativa, limite por hora, número na lista
 * de bloqueio, opt-out do cliente e número não discável.
 */
export async function assertSendAllowed(opts: {
  orgId: string;
  phone: string | null;
  customerId?: string | null;
}): Promise<GuardResult> {
  const { orgId, phone } = opts;

  const pause = await pauseInfo(orgId);
  if (pause.paused) return { ok: false, reason: `Envios pausados até ${pause.until}. ${pause.reason ?? ""}`.trim() };

  if (phone) {
    if (phone.length < 10 || phone.length > 15) {
      return { ok: false, reason: "Número fora do formato internacional (DDI + DDD + número)." };
    }
    const blocked = await db.whatsAppBlockedNumber.findUnique({
      where: { orgId_phone: { orgId, phone } },
    });
    if (blocked) return { ok: false, reason: "Este número está na lista de bloqueio desta clínica." };
  }

  if (opts.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: opts.customerId, orgId },
      select: { whatsappOptIn: true, name: true },
    });
    if (customer && !customer.whatsappOptIn) {
      return { ok: false, reason: `${customer.name} não aceita mensagens pelo WhatsApp (opt-out).` };
    }
  }

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const sentLastHour = await db.whatsAppMessage.count({
    where: { orgId, direction: "OUT", createdAt: { gte: since }, status: { not: "FAILED" } },
  });
  if (sentLastHour >= QUEUE_LIMITS.perHour) {
    return { ok: false, reason: `Limite de ${QUEUE_LIMITS.perHour} mensagens por hora atingido. A fila retoma na próxima hora.` };
  }

  return { ok: true };
}

/**
 * Coloca a mensagem na fila persistida (`Job`), já espaçada.
 * `runAt` vem do último envio + intervalo, então campanhas grandes viram uma escada em vez
 * de um pico — que é o que faz conta ser banida.
 */
export async function queueSendMessage(opts: { orgId: string; messageId: string; runAt?: Date; dedupeKey?: string }): Promise<void> {
  const lastSend = await db.whatsAppMessage.findFirst({
    where: { orgId: opts.orgId, direction: "OUT", sentAt: { not: null } },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });

  const earliest = lastSend?.sentAt ? new Date(lastSend.sentAt.getTime() + QUEUE_LIMITS.intervalMs) : new Date();
  const runAt = opts.runAt && opts.runAt > earliest ? opts.runAt : earliest;

  const dedupeKey = opts.dedupeKey ?? `wa:${opts.messageId}`;
  const { created } = await enqueueJob({
    type: "send_whatsapp",
    payload: { orgId: opts.orgId, messageId: opts.messageId },
    runAt,
    dedupeKey,
  });

  // Chave repetida = o job desta mensagem já existiu e terminou (DONE/DEAD). Reusar a linha
  // é o que evita o "aguardando" eterno: sem isto o create silencioso não deixa QUEUED com
  // nada que execute, e a mensagem some da fila sem nunca ter sido enviada.
  if (!created) {
    await db.job.updateMany({
      where: { dedupeKey, status: { in: ["DONE", "DEAD", "FAILED"] } },
      data: { status: "PENDING", runAt, attempts: 0, lastError: null, processedAt: null },
    });
  }
}

/** Quantos envios aguardam na fila agora (UI de Configurações → Fila). */
export async function queueDepth(orgId: string) {
  const [queued, jobs, pause] = await Promise.all([
    db.whatsAppMessage.count({ where: { orgId, direction: "OUT", status: "QUEUED" } }),
    db.job.count({ where: { orgId, type: "send_whatsapp", status: "PENDING" } }),
    pauseInfo(orgId),
  ]);
  return { messages: queued, jobs, paused: pause.paused, until: pause.until, reason: pause.reason };
}

/**
 * Executa um item da fila. Chamado pelo worker de jobs quando o `send_whatsapp` vence.
 *
 * Usa import dinâmico do serviço para não criar ciclo serviço ⇄ fila: o serviço enfileira,
 * a fila executa via serviço.
 */
export async function runQueuedSend(orgId: string, messageId: string): Promise<{ ok: boolean; status: string; error?: string }> {
  const message = await db.whatsAppMessage.findFirst({ where: { id: messageId, orgId } });
  if (!message) return { ok: false, status: "FAILED", error: "Mensagem não encontrada." };
  if (message.status !== "QUEUED") return { ok: true, status: message.status };

  const { sendMessage } = await import("./service");
  // `messageId` é o que evita a duplicação: o serviço atualiza ESTA linha em vez de
  // criar uma segunda mensagem para o mesmo envio.
  const outcome = await sendMessage({
    orgId,
    messageId: message.id,
    phone: message.phone,
    body: message.body,
    customerId: message.customerId,
    conversationId: message.conversationId,
    templateKey: message.templateKey ?? undefined,
    media:
      message.mediaUrl && ["image", "video", "audio", "document"].includes(message.messageType)
        ? {
            kind: message.messageType as "image" | "video" | "audio" | "document",
            url: message.mediaUrl,
            mimeType: message.mediaMime ?? undefined,
          }
        : undefined,
    immediate: true,
  });

  const { paused } = await noteSendResult(orgId, outcome.ok, outcome.error ?? null);
  if (paused) return { ok: false, status: "QUEUED", error: `${outcome.error ?? "falha"} (fila pausada)` };

  // Rede de segurança contra o "aguardando eterno": se o serviço disse que terminou mas a
  // linha seguiu QUEUED, o job morria e a mensagem ficava para sempre como pendente na tela.
  if (outcome.ok) {
    const still = await db.whatsAppMessage.findFirst({
      where: { id: message.id, orgId, status: "QUEUED" },
      select: { id: true },
    });
    if (still) {
      await failStuckQueued(orgId, message.id, "O envio terminou sem atualizar a mensagem. Reenvie.");
      return { ok: false, status: "FAILED", error: "Envio não confirmou a mensagem." };
    }
  }

  return { ok: outcome.ok, status: outcome.status, error: outcome.error };
}

/**
 * Tira uma mensagem do limbo: QUEUED sem job vivo não vai enviar nunca, então vira erro
 * visível (com botão de reenvio) em vez de um "aguardando" que engana o atendente.
 * Só mexe em linha que ainda está QUEUED — se chegou SENT/DELIVERED no meio do caminho, não.
 */
export async function failStuckQueued(orgId: string, messageId: string, reason: string): Promise<boolean> {
  const updated = await db.whatsAppMessage.updateMany({
    where: { id: messageId, orgId, direction: "OUT", status: "QUEUED" },
    data: { status: "FAILED", error: redact(reason) },
  });
  if (!updated.count) return false;

  const message = await db.whatsAppMessage.findUnique({
    where: { id: messageId },
    select: { conversationId: true },
  });
  await logWa({ orgId, level: "error", event: "message.stuck_failed", actor: messageId, detail: reason });
  if (message?.conversationId) publish({ type: "conversation.changed", orgId, conversationId: message.conversationId });
  publish({ type: "dashboard.changed", orgId });
  return true;
}

/**
 * Reconcilia mensagens presas em QUEUED sem job na fila (§26).
 *
 * Como o job pode se perder (restart no meio do PROCESSING, job deletado, mensagem criada por
 * versão antiga do código), a mensagem fica "aguardando" sem nada que a execute. Este pente
 * não reenvia nada sozinho — seria mandar mensagem que ninguém pediu agora. Ele só converte
 * o limbo em erro declarado, e é chamado na subida do worker e em /api/whatsapp/admin/backfill.
 */
export async function reconcileQueuedSends(orgId?: string, opts: { olderThanMs?: number } = {}) {
  const olderThanMs = opts.olderThanMs ?? 5 * 60_000;
  const cutoff = new Date(Date.now() - olderThanMs);

  const stale = await db.whatsAppMessage.findMany({
    where: {
      direction: "OUT",
      status: "QUEUED",
      createdAt: { lt: cutoff },
      ...(orgId ? { orgId } : {}),
    },
    select: { id: true, orgId: true },
    take: 200,
  });
  if (!stale.length) return { scanned: 0, marked: 0 };

  // Jobs vivos por org (o payload tem o messageId; comparamos em memória, são poucos).
  const liveJobs = await db.job.findMany({
    where: { type: "send_whatsapp", status: { in: ["PENDING", "PROCESSING"] }, ...(orgId ? { orgId } : {}) },
    select: { payload: true },
  });
  const live = new Set<string>();
  for (const j of liveJobs) {
    try {
      const parsed = JSON.parse(j.payload) as { messageId?: string };
      if (parsed.messageId) live.add(parsed.messageId);
    } catch {
      /* payload inválido: o próprio worker trata */
    }
  }

  let marked = 0;
  const perOrg = new Map<string, number>();
  for (const m of stale) {
    if (live.has(m.id)) continue;
    if (await failStuckQueued(m.orgId, m.id, "A fila perdeu esta mensagem antes de enviar. Reenvie.")) {
      marked++;
      perOrg.set(m.orgId, (perOrg.get(m.orgId) ?? 0) + 1);
    }
  }
  for (const [id, count] of perOrg) {
    await logWa({ orgId: id, level: "warn", event: "queue.reconciled", detail: `${count} mensagem(ns) presa(s) em QUEUED viraram erro visível` });
  }
  return { scanned: stale.length, marked };
}

/** Bloqueia um número (opt-out manual, reclamação, spam). */
export async function blockNumber(orgId: string, phone: string, reason: "opt_out" | "spam" | "manual" | "invalid" = "manual") {
  const digits = phone.replace(/\D/g, "");
  return db.whatsAppBlockedNumber.upsert({
    where: { orgId_phone: { orgId, phone: digits } },
    update: { reason },
    create: { orgId, phone: digits, reason },
  });
}

export async function unblockNumber(orgId: string, phone: string) {
  const digits = phone.replace(/\D/g, "");
  await db.whatsAppBlockedNumber.deleteMany({ where: { orgId, phone: digits } });
}
