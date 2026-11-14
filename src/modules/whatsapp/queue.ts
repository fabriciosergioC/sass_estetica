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
  /**
   * Tempo de espera quando o WhatsApp está desconectado ou a fila está pausada.
   * Não é falha: a mensagem continua QUEUED e o job volta depois, sem consumir tentativa.
   */
  offlineRetryMs: envNumber("WHATSAPP_OFFLINE_RETRY_MS", 120_000),
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

export type GuardCode = "PAUSED" | "RATE_LIMIT" | "BLOCKED" | "OPT_OUT" | "INVALID_NUMBER";

export type GuardResult = { ok: boolean; code?: GuardCode; reason?: string };

/**
 * Pente-fino antes de qualquer saída (§25): pausa ativa, limite por hora, número na lista
 * de bloqueio, opt-out do cliente e número não discável.
 *
 * `ignore` existe só para o botão "Forçar envios parados": ele é um pedido explícito do dono
 * da clínica para furar pausa/limite. Bloqueio, opt-out e número inválido continuam valendo —
 * forçar não é desculpa para falar com quem pediu para não receber.
 */
export async function assertSendAllowed(
  opts: {
    orgId: string;
    phone: string | null;
    customerId?: string | null;
  },
  ignore: { pause?: boolean; rateLimit?: boolean } = {}
): Promise<GuardResult> {
  const { orgId, phone } = opts;

  if (!ignore.pause) {
    const pause = await pauseInfo(orgId);
    if (pause.paused) {
      return { ok: false, code: "PAUSED", reason: `Envios pausados até ${pause.until}. ${pause.reason ?? ""}`.trim() };
    }
  }

  if (phone) {
    if (phone.length < 10 || phone.length > 15) {
      return { ok: false, code: "INVALID_NUMBER", reason: "Número fora do formato internacional (DDI + DDD + número)." };
    }
    const blocked = await db.whatsAppBlockedNumber.findUnique({
      where: { orgId_phone: { orgId, phone } },
    });
    if (blocked) return { ok: false, code: "BLOCKED", reason: "Este número está na lista de bloqueio desta clínica." };
  }

  if (opts.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: opts.customerId, orgId },
      select: { whatsappOptIn: true, name: true },
    });
    if (customer && !customer.whatsappOptIn) {
      return { ok: false, code: "OPT_OUT", reason: `${customer.name} não aceita mensagens pelo WhatsApp (opt-out).` };
    }
  }

  const since = new Date(Date.now() - 60 * 60 * 1000);
  // Só conta o que REALMENTE saiu (PENDING/SENT/DELIVERED/READ). Contar QUEUED/CANCELLED
  // transformava um backlog aguardando reconexão em "limite por hora atingido", travando
  // a fila justamente quando ela precisava escoar.
  //
  // A janela é do MOMENTO DA TENTATIVA, não da criação da linha. Com `createdAt`, um backlog
  // criado há 2h escoava sem contar no teto — e a fila podia passar de 60/h sem ninguém ver.
  // Linhas antigas (sem `lastAttemptAt`) mantêm o comportamento anterior como fallback.
  if (!ignore.rateLimit) {
    const sentLastHour = await db.whatsAppMessage.count({
      where: {
        orgId,
        direction: "OUT",
        status: { in: ["PENDING", "SENT", "DELIVERED", "READ"] },
        OR: [
          { lastAttemptAt: { gte: since } },
          { lastAttemptAt: null, createdAt: { gte: since } },
        ],
      },
    });
    if (sentLastHour >= QUEUE_LIMITS.perHour) {
      return {
        ok: false,
        code: "RATE_LIMIT",
        reason: `Limite de ${QUEUE_LIMITS.perHour} mensagens por hora atingido. A fila retoma na próxima hora.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Instante da última TENTATIVA de envio da org (aceita ou não).
 *
 * `sentAt` só é gravado quando o provedor confirma; enquanto a mensagem fica PENDING, ou
 * quando falha, ele continua nulo. Usar só `sentAt` fazia o espaçamento e o teto por hora
 * enxergarem "nenhum envio recente" e liberarem a fila em rajada. `lastAttemptAt` cobre
 * esses casos; `sentAt` fica como fallback para o histórico anterior à coluna.
 */
async function lastSendAttemptAt(orgId: string): Promise<number> {
  const [attempt, sent] = await Promise.all([
    db.whatsAppMessage.findFirst({
      where: { orgId, direction: "OUT", lastAttemptAt: { not: null } },
      orderBy: { lastAttemptAt: "desc" },
      select: { lastAttemptAt: true },
    }),
    db.whatsAppMessage.findFirst({
      where: { orgId, direction: "OUT", sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
  ]);
  return Math.max(attempt?.lastAttemptAt?.getTime() ?? 0, sent?.sentAt?.getTime() ?? 0);
}

/**
 * Coloca a mensagem na fila persistida (`Job`), já espaçada.
 * `runAt` vem do último envio + intervalo, então campanhas grandes viram uma escada em vez
 * de um pico — que é o que faz conta ser banida.
 */
export async function queueSendMessage(opts: { orgId: string; messageId: string; runAt?: Date; dedupeKey?: string }): Promise<void> {
  const lastAttempt = await lastSendAttemptAt(opts.orgId);

  const earliest = lastAttempt > 0 ? new Date(lastAttempt + QUEUE_LIMITS.intervalMs) : new Date();
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
 * Ao retomar a fila, traz para "agora" os envios que estavam esperando o fim da pausa.
 *
 * Quando a pausa é aplicada, o job é reprogramado para `until + 5s` — se a pausa era de
 * 15 minutos, retomar manualmente não adiantava nada: o job continuava dormindo até o fim
 * previsto. Aqui o `runAt` volta para agora; o espaçamento e o teto por hora continuam
 * valendo na execução.
 */
export async function pullForwardPausedSends(orgId: string): Promise<number> {
  const { count } = await db.job.updateMany({
    where: {
      orgId,
      type: "send_whatsapp",
      status: "PENDING",
      runAt: { gt: new Date() },
      lastError: { contains: "pausad" },
    },
    data: { runAt: new Date(), lastError: null },
  });
  return count;
}

/**
 * Executa um item da fila. Chamado pelo worker de jobs quando o `send_whatsapp` vence.
 *
 * Usa import dinâmico do serviço para não criar ciclo serviço ⇄ fila: o serviço enfileira,
 * a fila executa via serviço.
 */
export type QueuedSendOutcome = {
  ok: boolean;
  status: string;
  error?: string;
  /** true = não foi enviada por indisponibilidade; o job deve voltar depois (sem gastar tentativa). */
  deferred?: boolean;
  /** Quando o job pode voltar; ausente = usar QUEUE_LIMITS.offlineRetryMs. */
  retryAt?: Date;
};

export async function runQueuedSend(orgId: string, messageId: string): Promise<QueuedSendOutcome> {
  const message = await db.whatsAppMessage.findFirst({ where: { id: messageId, orgId } });
  if (!message) return { ok: false, status: "FAILED", error: "Mensagem não encontrada." };
  if (message.status !== "QUEUED") return { ok: true, status: message.status };

  // Pausa manual/automática: nem chamamos o serviço. Antes, a guarda de pausa cancelava a
  // mensagem (CANCELLED) e a fila perdia o lembrete de vez — agora ela só espera.
  const pause = await pauseInfo(orgId);
  if (pause.paused) {
    return {
      ok: false,
      status: "QUEUED",
      error: `Envios pausados até ${pause.until}. ${pause.reason ?? ""}`.trim(),
      deferred: true,
      retryAt: pause.until ? new Date(new Date(pause.until).getTime() + 5_000) : undefined,
    };
  }

  // Espaçamento em TEMPO DE EXECUÇÃO. O worker pega vários jobs vencidos de uma vez; antes,
  // o intervalo só era aplicado ao criar o job e 25 mensagens saíam em rajada. Devolver como
  // `deferred` não consome tentativa: é espera, não falha.
  const lastAttempt = await lastSendAttemptAt(orgId);
  const nextAllowedAt = lastAttempt + QUEUE_LIMITS.intervalMs;
  if (lastAttempt > 0 && Date.now() < nextAllowedAt) {
    return {
      ok: false,
      status: "QUEUED",
      error: `Aguardando o intervalo de ${QUEUE_LIMITS.intervalMs / 1000}s entre envios.`,
      deferred: true,
      retryAt: new Date(nextAllowedAt),
    };
  }

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

  // Desconexão (ou limite por hora) não é falha de envio: a mensagem segue QUEUED, o job
  // volta depois e o cliente não recebe o aviso como "não enviado" por algo temporário.
  if (outcome.deferred) {
    await logWa({
      orgId,
      level: "warn",
      event: "message.deferred",
      actor: message.phone,
      detail: outcome.error ?? "WhatsApp indisponível; envio reprogramado.",
    });
    return { ok: false, status: "QUEUED", error: outcome.error, deferred: true };
  }

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

export type ForceQueueResult = {
  scanned: number;
  sent: number;
  deferred: number;
  failed: number;
  skippedScheduled: number;
  skippedRunning: number;
  cancelled: number;
  errors: { messageId: string; error: string }[];
};

/** Pistas de que o job está parado esperando algo (pausa/queda), não agendado para depois. */
const DEFERRED_HINT = /pausad|desconect|indispon|aguardando|reconect|offline|limite/i;

/**
 * "Forçar envios parados": um clique explícito do painel para tirar da inércia o que está
 * em QUEUED e não vai sair sozinho — mensagem sem job, job vencido ou job reprogramado por
 * pausa/queda do WhatsApp.
 *
 * O que ele NÃO faz, de propósito:
 * - não antecipa lembrete agendado para o futuro (job PENDING com `runAt` à frente): isso
 *   não está parado, está esperando a hora;
 * - não reinvade job que já está PROCESSING (o worker está com ele agora);
 * - não envia para número bloqueado, cliente em opt-out, número inválido nem para
 *   agendamento cancelado/remarcado. Pausa e limite por hora são furados porque o clique
 *   é o dono da clínica pedindo: "manda agora".
 */
export async function forceDueQueuedSends(
  orgId: string,
  opts: { limit?: number; by?: string | null } = {}
): Promise<ForceQueueResult> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), 25);
  const now = Date.now();
  const result: ForceQueueResult = {
    scanned: 0,
    sent: 0,
    deferred: 0,
    failed: 0,
    skippedScheduled: 0,
    skippedRunning: 0,
    cancelled: 0,
    errors: [],
  };

  const messages = await db.whatsAppMessage.findMany({
    where: { orgId, direction: "OUT", status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      phone: true,
      body: true,
      customerId: true,
      conversationId: true,
      templateKey: true,
      appointmentId: true,
      mediaUrl: true,
      mediaMime: true,
      messageType: true,
      error: true,
    },
  });
  result.scanned = messages.length;
  if (!messages.length) return result;

  // Um job por mensagem: o payload carrega o messageId. Comparação em memória — são poucos.
  type JobRow = { id: string; status: string; runAt: Date; lastError: string | null; payload: string };
  const jobs = await db.job.findMany({
    where: { orgId, type: "send_whatsapp", status: { in: ["PENDING", "PROCESSING"] } },
    select: { id: true, status: true, runAt: true, lastError: true, payload: true },
  });
  const jobByMessage = new Map<string, JobRow>();
  for (const job of jobs as JobRow[]) {
    try {
      const parsed = JSON.parse(job.payload) as { messageId?: string };
      if (parsed.messageId) jobByMessage.set(parsed.messageId, job);
    } catch {
      /* payload inválido: o worker trata */
    }
  }

  const { sendMessage } = await import("./service");

  for (const message of messages) {
    const job = jobByMessage.get(message.id);

    if (job?.status === "PROCESSING") {
      result.skippedRunning++;
      continue;
    }

    const deferredHint = DEFERRED_HINT.test(`${job?.lastError ?? ""} ${message.error ?? ""}`);
    if (job && job.status === "PENDING" && job.runAt.getTime() > now + 30_000 && !deferredHint) {
      result.skippedScheduled++;
      continue;
    }

    // Mesma proteção do worker: agendamento cancelado/remarcado não recebe confirmação nem
    // lembrete — só os avisos que EXISTEM para anunciar essa mudança.
    const anunciaMudanca = message.templateKey === "cancellation" || message.templateKey === "reschedule";
    if (message.appointmentId && !anunciaMudanca) {
      const appt = await db.appointment.findFirst({
        where: { id: message.appointmentId, orgId },
        select: { status: true },
      });
      if (appt && ["CANCELLED", "RESCHEDULED"].includes(appt.status)) {
        await db.whatsAppMessage.update({
          where: { id: message.id },
          data: { status: "CANCELLED", error: "Agendamento cancelado/remarcado antes do envio." },
        });
        result.cancelled++;
        continue;
      }
    }

    // Reivindica o job antes de enviar: sem isto o worker poderia pegar o mesmo PENDING e
    // mandar a mensagem duas vezes enquanto este clique já está com ela.
    if (job?.status === "PENDING") {
      await db.job.update({
        where: { id: job.id },
        data: { status: "DONE", processedAt: new Date(), lastError: null },
      });
    }

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
      force: true,
    });

    if (outcome.deferred) {
      // Continua sem saída (WhatsApp ainda fora do ar): devolve à fila para tentar depois,
      // em vez de deixar a mensagem sem nada que a execute.
      result.deferred++;
      await queueSendMessage({ orgId, messageId: message.id });
      continue;
    }

    if (outcome.ok) {
      result.sent++;
    } else {
      result.failed++;
      result.errors.push({ messageId: message.id, error: outcome.error ?? "Falha no envio." });
    }
  }

  await logWa({
    orgId,
    event: "queue.forced",
    actor: opts.by ?? null,
    detail:
      `${result.sent} enviada(s), ${result.deferred} reprogramada(s), ${result.failed} falha(s), ` +
      `${result.skippedScheduled} agendada(s) para depois, ${result.skippedRunning} em execução, ${result.cancelled} cancelada(s).`,
  });
  publish({ type: "dashboard.changed", orgId });
  return result;
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
