// Fila de jobs assíncronos persistida no banco (tabela Job).
// Worker in-process: processJobs() pode ser chamado após a resposta ou por uma rota cron.
// Retry com backoff; após maxAttempts vira DEAD (dead-letter).
import { after } from "next/server";
import { db } from "@/lib/db";

export type JobType =
  | "send_whatsapp"
  | "compute_metrics"
  | "detect_opportunities"
  | "notify_admin";

export type JobPayload = {
  orgId: string;
  /** send_whatsapp */
  messageId?: string;
  /** compute_metrics */
  customerId?: string;
  /** notify_admin */
  notification?: { type: string; title: string; body?: string };
  [key: string]: unknown;
};

export async function enqueueJob(opts: {
  type: JobType;
  payload: JobPayload;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}): Promise<{ created: boolean }> {
  try {
    await db.job.create({
      data: {
        type: opts.type,
        payload: JSON.stringify(opts.payload),
        orgId: opts.payload.orgId,
        runAt: opts.runAt ?? new Date(),
        dedupeKey: opts.dedupeKey,
        maxAttempts: opts.maxAttempts ?? 3,
      },
    });
  } catch (err) {
    // dedupeKey único violado = job já agendado; outros erros são logados.
    if ((err as { code?: string }).code !== "P2002") throw err;
    return { created: false };
  }
  // Processa o mais cedo possível fora do caminho da requisição.
  // Jobs com runAt futuro só rodam via /api/cron.
  try {
    after(() => processJobs().catch(() => 0));
  } catch {
    // fora de contexto de requisição (ex: seed/cron) — o chamador processa
  }
  return { created: true };
}

type JobRunResult = { deferred?: boolean; error?: string; retryAt?: Date } | void;

/**
 * Devolve à fila os jobs que ficaram em PROCESSING quando o processo caiu (deploy/restart
 * no meio do envio). Sem isto eles ficam "vivos" para sempre: o pente de mensagens presas
 * os considera em andamento e a mensagem nunca sai. Só é seguro com um worker por processo,
 * que é a premissa do socket único do Baileys.
 */
export async function requeueOrphanProcessing(): Promise<number> {
  const { count } = await db.job.updateMany({
    where: { status: "PROCESSING" },
    data: { status: "PENDING", runAt: new Date() },
  });
  return count;
}

/** Espera entre tentativas quando o WhatsApp está fora do ar / fila pausada. */
function deferredRetryMs() {
  const raw = Number(process.env.WHATSAPP_OFFLINE_RETRY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

async function handleSendWhatsapp(jobId: string, payload: JobPayload): Promise<JobRunResult> {
  const message = await db.whatsAppMessage.findFirst({
    where: { id: payload.messageId, orgId: payload.orgId },
  });
  if (!message) return; // mensagem removida: nada a fazer
  if (message.status !== "QUEUED") return; // já enviada (idempotência)

  // Agendamento cancelado/remarcado após o agendamento do job: não envia mais.
  // Mas os templates que EXISTEM PARA ANUNCIAR essa mudança ficam de fora — era aqui que o
  // cancelamento morria: o bloco de `changeStatus` cria a mensagem "seu horário foi cancelado",
  // o job roda segundos depois, vê o agendamento CANCELLED e cancela a própria mensagem
  // (visto 2026-11-03: linhas `cancellation` em CANCELLED, nunca saíram).
  const anunciaMudanca = message.templateKey === "cancellation" || message.templateKey === "reschedule";
  if (message.appointmentId && !anunciaMudanca) {
    const appt = await db.appointment.findUnique({
      where: { id: message.appointmentId },
      select: { status: true },
    });
    if (appt && ["CANCELLED", "RESCHEDULED"].includes(appt.status)) {
      await db.whatsAppMessage.update({
        where: { id: message.id },
        data: { status: "CANCELLED", error: "Agendamento cancelado/remarcado antes do envio." },
      });
      return;
    }
  }

  // A fila de WhatsApp é quem conhece provedor, proteções (§25) e status real de entrega.
  // Este handler já montou um provedor por conta própria no passado — foi assim que job e
  // tela passaram a discordar sobre a mesma mensagem.
  const { runQueuedSend } = await import("@/modules/whatsapp/queue");
  const outcome = await runQueuedSend(payload.orgId, message.id);

  // Indisponibilidade (desconectado/pausado/limite): não é erro de envio. A mensagem fica
  // QUEUED e o job volta depois, sem consumir tentativa — é o que faz a fila retomar sozinha
  // depois de escanear o QR, em vez de morrer em DEAD e exigir reenvio manual.
  if (outcome.deferred) {
    return { deferred: true, error: outcome.error, retryAt: outcome.retryAt };
  }

  if (!outcome.ok) throw new Error(outcome.error ?? "Falha no envio pela fila.");
}

async function runJob(job: { id: string; type: string; payload: string }): Promise<JobRunResult> {
  const payload = JSON.parse(job.payload) as JobPayload;
  switch (job.type as JobType) {
    case "send_whatsapp":
      return handleSendWhatsapp(job.id, payload);
    case "compute_metrics": {
      const { computeCustomerMetrics } = await import("@/modules/crm/metrics");
      if (payload.customerId) await computeCustomerMetrics(payload.orgId, payload.customerId);
      return;
    }
    case "detect_opportunities": {
      const { detectOpportunities } = await import("@/modules/intelligence/opportunities");
      await detectOpportunities(payload.orgId);
      return;
    }
    case "notify_admin": {
      const p = payload.notification;
      if (!p) return;
      await db.notification.create({
        data: { orgId: payload.orgId, type: p.type, title: p.title, body: p.body },
      });
      return;
    }
    default:
      throw new Error(`Tipo de job desconhecido: ${job.type}`);
  }
}

/** Processa jobs pendentes vencidos. Retorna quantos processou. */
export async function processJobs(limit = 25): Promise<number> {
  const now = new Date();
  const jobs = await db.job.findMany({
    where: { status: "PENDING", runAt: { lte: now } },
    orderBy: { runAt: "asc" },
    take: limit,
  });

  let done = 0;
  for (const job of jobs) {
    // claim atômico simples (evita duplicar entre workers concorrentes)
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claimed.count === 0) continue;

    try {
      const result = await runJob(job);

      // Volta para a fila mais tarde SEM contar tentativa: é espera, não falha.
      if (result?.deferred) {
        await db.job.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            runAt: result.retryAt ?? new Date(Date.now() + deferredRetryMs()),
            lastError: result.error ?? "WhatsApp indisponível; envio reprogramado.",
          },
        });
        continue;
      }

      await db.job.update({
        where: { id: job.id },
        data: { status: "DONE", processedAt: new Date(), attempts: job.attempts + 1 },
      });
      done++;
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= job.maxAttempts) {
        await db.job.update({
          where: { id: job.id },
          data: { status: "DEAD", attempts, lastError: message, processedAt: new Date() },
        });
        await db.notification
          .create({
            data: {
              orgId: job.orgId ?? (JSON.parse(job.payload) as JobPayload).orgId,
              type: "AUTOMATION_ERROR",
              title: "Falha em processo automático",
              body: `Job ${job.type}: ${message}`.slice(0, 300),
            },
          })
          .catch(() => {});
      } else {
        const backoffMs = 2 ** attempts * 60_000; // 2min, 4min...
        await db.job.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            attempts,
            lastError: message,
            runAt: new Date(Date.now() + backoffMs),
          },
        });
      }
    }
  }
  return done;
}