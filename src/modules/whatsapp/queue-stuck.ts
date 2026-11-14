import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { QUEUE_LIMITS, pauseInfo, queueSendMessage } from "./queue";
import { logWa, redact } from "./logs";
import { publish } from "./bus";

/**
 * Diagnóstico e recuperação da fila travada (§26).
 *
 * Este módulo existe porque "Na fila" sozinho não conta a história: pode ser uma mensagem
 * sem job (nada vai executá-la), um job morto depois das tentativas, um job vencido que o
 * worker não pegou ou uma mensagem que só está esperando o WhatsApp reconectar. O painel
 * precisa separar esses casos antes de oferecer o reenvio.
 *
 * Regra de ouro: reenviar NUNCA é "mandar de novo por fora". A mensagem volta para o MESMO
 * job/linha, com espaçamento entre envios e passando de novo por pausa, limite por hora,
 * bloqueio, opt-out e agendamento cancelado. É isso que evita duplicar mensagem e tomar
 * bloqueio do WhatsApp por disparo em rajada.
 */

const PREVIEW_MAX = 160;
const SCHEDULED_AHEAD_MS = 30_000;
const OVERDUE_MS = 5 * 60_000;
/** Job em PROCESSING por mais que isso é considerado órfão (o worker morreu no meio). */
export const STUCK_PROCESSING_MS = 15 * 60_000;
/**
 * Erros e jobs mortos mais antigos que isso ficam fora do painel de propósito: reenviar um
 * aviso de duas semanas atrás é pior do que deixá-lo no histórico. O passado continua nos
 * Logs, mas não vira um clique acidental de "manda de novo".
 */
export const STUCK_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Pistas de que o job está parado esperando algo (pausa/queda), não agendado para depois. */
const DEFERRED_HINT = /pausad|desconect|indispon|aguardando|reconect|offline/i;

const messageSelect = {
  id: true,
  status: true,
  phone: true,
  body: true,
  templateKey: true,
  appointmentId: true,
  error: true,
  createdAt: true,
  conversation: {
    select: {
      contact: { select: { name: true } },
      customer: { select: { name: true } },
    },
  },
} satisfies Prisma.WhatsAppMessageSelect;

type MessageRow = Prisma.WhatsAppMessageGetPayload<{ select: typeof messageSelect }>;

type SendJobRow = {
  id: string;
  status: string;
  runAt: Date;
  lastError: string | null;
  attempts: number;
  payload: string;
};

export type StuckSituation = "stuck" | "waiting" | "scheduled" | "running" | "failed";

export type StuckQueueItem = {
  id: string;
  status: string;
  phone: string;
  contactName: string | null;
  customerName: string | null;
  preview: string;
  templateKey: string | null;
  createdAt: string;
  error: string | null;
  situation: StuckSituation;
  retryable: boolean;
  note: string | null;
  job: { id: string; status: string; runAt: string; lastError: string | null; attempts: number } | null;
};

export type DeadJobItem = {
  id: string;
  type: string;
  messageId: string | null;
  messageStatus: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  retryable: boolean;
  note: string | null;
};

export type ProcessingJobItem = {
  id: string;
  type: string;
  messageId: string | null;
  runAt: string;
  attempts: number;
  createdAt: string;
};

export type StuckQueueSnapshot = {
  pause: { paused: boolean; until: string | null; reason: string | null };
  limits: typeof QUEUE_LIMITS;
  counts: {
    queued: number;
    stuck: number;
    waiting: number;
    scheduled: number;
    running: number;
    failed: number;
    deadJobs: number;
    processing: number;
  };
  queued: StuckQueueItem[];
  failed: StuckQueueItem[];
  deadJobs: DeadJobItem[];
  processing: ProcessingJobItem[];
  truncated: { queued: boolean; failed: boolean };
};

function clampLimit(raw: number | undefined, fallback = 25) {
  const value = Number.isFinite(raw) ? Math.trunc(raw as number) : fallback;
  return Math.min(Math.max(value, 1), 25);
}

function parseMessageId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { messageId?: string };
    return parsed.messageId ?? null;
  } catch {
    return null;
  }
}

/**
 * Um job por mensagem na prática (dedupeKey `wa:<id>`), mas dados antigos podem ter mais de
 * um. Quando houver, vale o mais vivo: PROCESSING > PENDING > DEAD.
 */
async function sendJobsByMessage(orgId: string) {
  const jobs = await db.job.findMany({
    where: { orgId, type: "send_whatsapp", status: { in: ["PENDING", "PROCESSING", "DEAD"] } },
    select: { id: true, status: true, runAt: true, lastError: true, attempts: true, payload: true },
  });
  const priority: Record<string, number> = { PROCESSING: 3, PENDING: 2, DEAD: 1 };
  const map = new Map<string, SendJobRow>();
  for (const job of jobs) {
    const messageId = parseMessageId(job.payload);
    if (!messageId) continue;
    const current = map.get(messageId);
    if (!current || (priority[job.status] ?? 0) > (priority[current.status] ?? 0)) map.set(messageId, job);
  }
  return map;
}

function classifyQueued(job: SendJobRow | undefined, now: number) {
  if (!job) {
    return {
      situation: "stuck" as const,
      retryable: true,
      note: "Sem job na fila: nada vai executar esta mensagem.",
    };
  }
  if (job.status === "PROCESSING") {
    return {
      situation: "running" as const,
      retryable: false,
      note: "O worker está com esta mensagem agora.",
    };
  }
  if (job.status === "DEAD") {
    return {
      situation: "stuck" as const,
      retryable: true,
      note: "O job esgotou as tentativas (dead-letter).",
    };
  }

  const ahead = job.runAt.getTime() > now + SCHEDULED_AHEAD_MS;
  const deferred = DEFERRED_HINT.test(job.lastError ?? "");
  if (ahead && !deferred) {
    return {
      situation: "scheduled" as const,
      retryable: false,
      note: `Agendada para ${job.runAt.toLocaleString("pt-BR")}.`,
    };
  }
  if (job.runAt.getTime() < now - OVERDUE_MS) {
    return {
      situation: "stuck" as const,
      retryable: true,
      note: "Job vencido e ainda não executado.",
    };
  }
  return {
    situation: "waiting" as const,
    retryable: false,
    note: job.lastError ?? "Aguardando o worker ou o WhatsApp reconectar.",
  };
}

function toQueuedItem(
  message: MessageRow,
  job: SendJobRow | undefined,
  classification: { situation: StuckSituation; retryable: boolean; note: string | null }
): StuckQueueItem {
  return {
    id: message.id,
    status: message.status,
    phone: message.phone,
    contactName: message.conversation?.contact?.name ?? null,
    customerName: message.conversation?.customer?.name ?? null,
    preview: redact(message.body, PREVIEW_MAX) ?? "",
    templateKey: message.templateKey,
    createdAt: message.createdAt.toISOString(),
    error: redact(message.error),
    situation: classification.situation,
    retryable: classification.retryable,
    note: classification.note,
    job: job
      ? {
          id: job.id,
          status: job.status,
          runAt: job.runAt.toISOString(),
          lastError: redact(job.lastError),
          attempts: job.attempts,
        }
      : null,
  };
}

/** Fotografia da fila para o painel "Fila travada". Somente leitura. */
export async function listStuckSends(orgId: string): Promise<StuckQueueSnapshot> {
  const now = Date.now();
  const processingCutoff = new Date(now - STUCK_PROCESSING_MS);
  const windowStart = new Date(now - STUCK_WINDOW_MS);

  const [pause, queuedRows, failedRows, deadRows, processingRows, queuedTotal, failedTotal, deadTotal, processingTotal] =
    await Promise.all([
      pauseInfo(orgId),
      db.whatsAppMessage.findMany({
        where: { orgId, direction: "OUT", status: "QUEUED" },
        orderBy: { createdAt: "asc" },
        take: 200,
        select: messageSelect,
      }),
      db.whatsAppMessage.findMany({
        where: { orgId, direction: "OUT", status: "FAILED", createdAt: { gte: windowStart } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: messageSelect,
      }),
      db.job.findMany({
        where: { orgId, status: "DEAD", createdAt: { gte: windowStart } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          type: true,
          payload: true,
          lastError: true,
          attempts: true,
          maxAttempts: true,
          createdAt: true,
        },
      }),
      db.job.findMany({
        where: { orgId, status: "PROCESSING", runAt: { lt: processingCutoff } },
        orderBy: { runAt: "asc" },
        take: 50,
        select: { id: true, type: true, payload: true, runAt: true, attempts: true, createdAt: true },
      }),
      db.whatsAppMessage.count({ where: { orgId, direction: "OUT", status: "QUEUED" } }),
      db.whatsAppMessage.count({
        where: { orgId, direction: "OUT", status: "FAILED", createdAt: { gte: windowStart } },
      }),
      db.job.count({ where: { orgId, status: "DEAD", createdAt: { gte: windowStart } } }),
      db.job.count({ where: { orgId, status: "PROCESSING", runAt: { lt: processingCutoff } } }),
    ]);

  const jobByMessage = await sendJobsByMessage(orgId);

  const queued: StuckQueueItem[] = [];
  const counts = {
    queued: queuedTotal,
    stuck: 0,
    waiting: 0,
    scheduled: 0,
    running: 0,
    failed: failedTotal,
    deadJobs: deadTotal,
    processing: processingTotal,
  };

  for (const message of queuedRows) {
    const job = jobByMessage.get(message.id);
    const classification = classifyQueued(job, now);
    counts[classification.situation === "stuck" ? "stuck" : classification.situation] += 1;
    queued.push(toQueuedItem(message, job, classification));
  }

  const failed = failedRows.map((message) =>
    toQueuedItem(message, undefined, { situation: "failed", retryable: true, note: null })
  );

  // Jobs mortos: para send_whatsapp, a mensagem precisa aceitar voltar para QUEUED. Se ela já
  // saiu, reviver o job só geraria trabalho inútil (e risco de confusão), então não é oferecido.
  const deadMessageIds = [
    ...new Set(
      deadRows
        .filter((job) => job.type === "send_whatsapp")
        .map((job) => parseMessageId(job.payload))
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const deadMessages = deadMessageIds.length
    ? await db.whatsAppMessage.findMany({
        where: { orgId, id: { in: deadMessageIds } },
        select: { id: true, status: true },
      })
    : [];
  const statusByMessage = new Map(deadMessages.map((m) => [m.id, m.status]));

  const deadJobs: DeadJobItem[] = deadRows.map((job) => {
    const messageId = job.type === "send_whatsapp" ? parseMessageId(job.payload) : null;
    const messageStatus = messageId ? statusByMessage.get(messageId) ?? null : null;
    let retryable = true;
    let note: string | null = null;

    if (job.type === "send_whatsapp") {
      if (!messageId) {
        retryable = false;
        note = "Job antigo sem mensagem vinculada.";
      } else if (!messageStatus) {
        retryable = false;
        note = "A mensagem não existe mais.";
      } else if (messageStatus !== "QUEUED" && messageStatus !== "FAILED") {
        retryable = false;
        note = `A mensagem já está ${messageStatus}.`;
      }
    }

    return {
      id: job.id,
      type: job.type,
      messageId,
      messageStatus,
      error: redact(job.lastError),
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt.toISOString(),
      retryable,
      note,
    };
  });

  const processing: ProcessingJobItem[] = processingRows.map((job) => ({
    id: job.id,
    type: job.type,
    messageId: parseMessageId(job.payload),
    runAt: job.runAt.toISOString(),
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
  }));

  return {
    pause,
    limits: QUEUE_LIMITS,
    counts,
    queued,
    failed,
    deadJobs,
    processing,
    truncated: { queued: queuedTotal > queuedRows.length, failed: failedTotal > failedRows.length },
  };
}

export type QueueActionResult = {
  scanned: number;
  retried: number;
  revived: number;
  skipped: number;
  errors: { id: string; error: string }[];
  skippedReasons: { id: string; reason: string }[];
  paused?: boolean;
};

function emptyResult(): QueueActionResult {
  return { scanned: 0, retried: 0, revived: 0, skipped: 0, errors: [], skippedReasons: [] };
}

/**
 * Devolve mensagens travadas/com erro para a fila, em escada.
 *
 * - QUEUED sem job / com job DEAD: recria/revive o job.
 * - QUEUED com job vencido: só empurra o `runAt` para agora (não duplica job).
 * - FAILED: volta a linha para QUEUED e reenfileira — a MESMA linha, sem histórico novo.
 * - Agendada para o futuro ou em execução: fica de fora. Antecipar lembrete não é "destravar".
 *
 * O espaçamento usa `WHATSAPP_SEND_INTERVAL_MS`; o limite por hora e a pausa continuam
 * valendo no envio. Se a fila estiver pausada, nada é enfileirado e o painel avisa para
 * retomar primeiro.
 */
export async function retryStuckSends(
  orgId: string,
  opts: { ids?: string[]; scope?: "queued" | "failed" | "all"; limit?: number; by?: string | null } = {}
): Promise<QueueActionResult> {
  const result = emptyResult();
  const pause = await pauseInfo(orgId);
  if (pause.paused) return { ...result, paused: true };

  const limit = clampLimit(opts.limit);
  const statuses =
    opts.scope === "queued" ? ["QUEUED"] : opts.scope === "failed" ? ["FAILED"] : ["QUEUED", "FAILED"];

  const jobByMessage = await sendJobsByMessage(orgId);
  const now = Date.now();
  const windowStart = new Date(now - STUCK_WINDOW_MS);

  let messages: MessageRow[];
  if (opts.ids?.length) {
    // Seleção explícita do painel: o loop abaixo ainda confere agendamento/execução e ignora
    // o que não pode sair. É o caminho do "Reenviar selecionadas".
    messages = await db.whatsAppMessage.findMany({
      where: { orgId, direction: "OUT", status: { in: statuses }, id: { in: opts.ids } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: messageSelect,
    });
    // Mesmo com id explícito, erro antigo não volta: o painel só mostra 7 dias.
    messages = messages.filter((m) => m.status !== "FAILED" || m.createdAt >= windowStart);
  } else {
    // "Reenviar até 25" precisa mirar no que está TRAVADO, não nos 25 primeiros da fila —
    // senão uma leva de lembretes agendados para o futuro consumiria o lote sem reenviar nada.
    const wantsQueued = statuses.includes("QUEUED");
    const wantsFailed = statuses.includes("FAILED");
    const [queuedCandidates, failedCandidates] = await Promise.all([
      wantsQueued
        ? db.whatsAppMessage.findMany({
            where: { orgId, direction: "OUT", status: "QUEUED" },
            orderBy: { createdAt: "asc" },
            take: 200,
            select: messageSelect,
          })
        : Promise.resolve([]),
      wantsFailed
        ? db.whatsAppMessage.findMany({
            where: { orgId, direction: "OUT", status: "FAILED", createdAt: { gte: windowStart } },
            // Erro mais recente primeiro: é o que o painel mostra e o que a pessoa acabou
            // de ver na conversa.
            orderBy: { createdAt: "desc" },
            take: 50,
            select: messageSelect,
          })
        : Promise.resolve([]),
    ]);
    const eligibleQueued = queuedCandidates.filter(
      (message) => classifyQueued(jobByMessage.get(message.id), now).retryable
    );
    messages = [...eligibleQueued, ...failedCandidates].slice(0, limit);
  }

  result.scanned = messages.length;
  if (!messages.length) return result;

  // Mesma proteção do worker: agendamento cancelado/remarcado não recebe confirmação nem
  // lembrete. Os templates que anunciam a mudança continuam valendo.
  const appointmentIds = [...new Set(messages.map((m) => m.appointmentId).filter((id): id is string => Boolean(id)))];
  const appointments = appointmentIds.length
    ? await db.appointment.findMany({
        where: { orgId, id: { in: appointmentIds } },
        select: { id: true, status: true },
      })
    : [];
  const appointmentStatus = new Map(appointments.map((a) => [a.id, a.status]));

  const base = Date.now();
  let slot = 0;
  const nextRunAt = () => new Date(base + slot++ * QUEUE_LIMITS.intervalMs);

  for (const message of messages) {
    const job = jobByMessage.get(message.id);

    if (job?.status === "PROCESSING") {
      result.skipped++;
      result.skippedReasons.push({ id: message.id, reason: "O worker está com esta mensagem agora." });
      continue;
    }
    if (job?.status === "PENDING") {
      const ahead = job.runAt.getTime() > Date.now() + SCHEDULED_AHEAD_MS;
      const deferred = DEFERRED_HINT.test(job.lastError ?? "");
      if (ahead && !deferred) {
        result.skipped++;
        result.skippedReasons.push({ id: message.id, reason: "Agendada para o futuro; não foi antecipada." });
        continue;
      }
    }

    const anunciaMudanca = message.templateKey === "cancellation" || message.templateKey === "reschedule";
    if (message.appointmentId && !anunciaMudanca) {
      const status = appointmentStatus.get(message.appointmentId);
      if (status && ["CANCELLED", "RESCHEDULED", "NO_SHOW"].includes(status)) {
        result.skipped++;
        result.skippedReasons.push({
          id: message.id,
          reason: "Agendamento cancelado/remarcado: mensagem não deve sair.",
        });
        continue;
      }
    }

    try {
      if (message.status === "FAILED") {
        // Só ressuscita linha que AINDA está FAILED. Se ela virou SENT no meio do caminho,
        // o update não pega e nada é duplicado.
        const updated = await db.whatsAppMessage.updateMany({
          where: { id: message.id, orgId, direction: "OUT", status: "FAILED" },
          data: { status: "QUEUED", error: null, providerMsgId: null, sentAt: null, deliveredAt: null, readAt: null },
        });
        if (!updated.count) {
          result.skipped++;
          result.skippedReasons.push({ id: message.id, reason: "A mensagem mudou de status enquanto era reenviada." });
          continue;
        }
      }

      if (job?.status === "PENDING") {
        // Job vivo: só antecipa. Nada de criar um segundo job para a mesma mensagem.
        await db.job.updateMany({ where: { id: job.id, status: "PENDING" }, data: { runAt: nextRunAt() } });
      } else {
        // Sem job ou job DEAD: queueSendMessage revive a MESMA linha de job (dedupeKey).
        await queueSendMessage({ orgId, messageId: message.id, runAt: nextRunAt() });
      }
      result.retried++;
    } catch (err) {
      result.errors.push({ id: message.id, error: redact(err instanceof Error ? err.message : String(err)) ?? "Falha ao reenfileirar." });
    }
  }

  if (result.retried > 0) {
    await logWa({
      orgId,
      event: "queue.stuck_retry",
      actor: opts.by ?? null,
      detail:
        `${result.retried} de ${result.scanned} mensagem(ns) devolvida(s) à fila` +
        (result.skipped ? `; ${result.skipped} ignorada(s)` : "") +
        (result.errors.length ? `; ${result.errors.length} erro(s)` : "") +
        ".",
    });
    publish({ type: "dashboard.changed", orgId });
  }

  return result;
}

/** Revive jobs em DEAD (dead-letter). Para send_whatsapp, devolve a mensagem a QUEUED antes. */
export async function reviveDeadJobs(
  orgId: string,
  opts: { ids?: string[]; limit?: number; by?: string | null } = {}
): Promise<QueueActionResult> {
  const result = emptyResult();
  const limit = clampLimit(opts.limit);

  const jobs = await db.job.findMany({
    where: {
      orgId,
      status: "DEAD",
      createdAt: { gte: new Date(Date.now() - STUCK_WINDOW_MS) },
      ...(opts.ids?.length ? { id: { in: opts.ids } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, type: true, payload: true },
  });
  result.scanned = jobs.length;
  if (!jobs.length) return result;

  const base = Date.now();
  let slot = 0;

  for (const job of jobs) {
    try {
      if (job.type === "send_whatsapp") {
        const messageId = parseMessageId(job.payload);
        const message = messageId
          ? await db.whatsAppMessage.findFirst({
              where: { id: messageId, orgId },
              select: { id: true, status: true },
            })
          : null;

        if (!message) {
          result.skipped++;
          result.skippedReasons.push({ id: job.id, reason: "A mensagem não existe mais." });
          continue;
        }
        if (message.status !== "QUEUED" && message.status !== "FAILED") {
          result.skipped++;
          result.skippedReasons.push({ id: job.id, reason: `A mensagem já está ${message.status}.` });
          continue;
        }
        if (message.status === "FAILED") {
          await db.whatsAppMessage.update({
            where: { id: message.id },
            data: { status: "QUEUED", error: null, providerMsgId: null, sentAt: null, deliveredAt: null, readAt: null },
          });
        }
      }

      const updated = await db.job.updateMany({
        where: { id: job.id, status: "DEAD" },
        data: {
          status: "PENDING",
          attempts: 0,
          runAt: new Date(base + slot++ * QUEUE_LIMITS.intervalMs),
          lastError: null,
          processedAt: null,
        },
      });
      if (updated.count) result.revived++;
      else {
        result.skipped++;
        result.skippedReasons.push({ id: job.id, reason: "O job mudou de status enquanto era revivido." });
      }
    } catch (err) {
      result.errors.push({ id: job.id, error: redact(err instanceof Error ? err.message : String(err)) ?? "Falha ao reviver." });
    }
  }

  if (result.revived > 0) {
    await logWa({
      orgId,
      event: "queue.jobs_revived",
      actor: opts.by ?? null,
      detail: `${result.revived} job(s) DEAD devolvido(s) à fila.`,
    });
    publish({ type: "dashboard.changed", orgId });
  }

  return result;
}

/**
 * Devolve à fila jobs que ficaram em PROCESSING por tempo demais (processo caiu no meio).
 *
 * O worker já faz isso na subida; este botão serve para quando o processo sobreviveu mas o
 * envio morreu (ex.: socket travado). Só mexe no que está PROCESSING há mais de 15 minutos —
 * job recém-reivindicado pode estar enviando de verdade.
 */
export async function requeueStuckProcessing(
  orgId: string,
  opts: { by?: string | null; olderThanMs?: number } = {}
): Promise<{ requeued: number }> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? STUCK_PROCESSING_MS));
  const { count } = await db.job.updateMany({
    where: { orgId, status: "PROCESSING", runAt: { lt: cutoff } },
    data: { status: "PENDING", runAt: new Date() },
  });

  if (count > 0) {
    await logWa({
      orgId,
      level: "warn",
      event: "queue.processing_requeued",
      actor: opts.by ?? null,
      detail: `${count} job(s) presos em PROCESSING por mais de ${Math.round(
        (opts.olderThanMs ?? STUCK_PROCESSING_MS) / 60_000
      )} min voltaram para PENDING.`,
    });
    publish({ type: "dashboard.changed", orgId });
  }

  return { requeued: count };
}
