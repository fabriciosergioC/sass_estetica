import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { QUEUE_LIMITS, pauseInfo, queueDepth, resumeSending, pauseSending, forceDueQueuedSends, pullForwardPausedSends } from "@/modules/whatsapp/queue";
import { db } from "@/lib/db";

/**
 * /api/whatsapp/queue — estado e controle da fila de saída (§26).
 *
 * Pausar é para o atendimento ("chegue de mensagens, pare tudo"); retomar é manual, porque a
 * pausa automática por falha em série só expira sozinha depois do tempo configurado.
 */

export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const [depth, pause] = await Promise.all([queueDepth(orgId), pauseInfo(orgId)]);

    const upcoming = await db.job.findMany({
      where: { orgId, type: "send_whatsapp", status: "PENDING" },
      orderBy: { runAt: "asc" },
      take: 20,
      select: { id: true, runAt: true, attempts: true, lastError: true },
    });

    return jsonOk({ ...depth, pause, limits: QUEUE_LIMITS, upcoming });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.object({
  action: z.enum(["pause", "resume", "force"]),
  reason: z.string().max(200).optional(),
  minutes: z.number().int().min(1).max(1440).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    if (body.action === "pause") {
      await pauseSending(orgId, body.reason ?? "Pausado manualmente pelo painel", body.minutes);
      return jsonOk({ ...(await queueDepth(orgId)), limits: QUEUE_LIMITS });
    }

    if (body.action === "resume") {
      await resumeSending(orgId, session.userId);
      // Os jobs pausados estavam com runAt no fim da pausa (até 15 min à frente). Retomar sem
      // puxá-los de volta não adiantava nada — a fila só voltava no horário previsto.
      const pulled = await pullForwardPausedSends(orgId);
      const { wakeJobWorker } = await import("@/modules/automation/worker");
      wakeJobWorker();
      return jsonOk({ ...(await queueDepth(orgId)), limits: QUEUE_LIMITS, pulled });
    }

    // "Forçar": tenta agora o que está preso em QUEUED (sem job, job vencido ou reprogramado
    // por pausa/queda). Não antecipa lembrete agendado para o futuro — isso não está parado.
    const result = await forceDueQueuedSends(orgId, { limit: body.limit, by: session.userId });
    await db.auditLog
      .create({
        data: {
          orgId,
          userId: session.userId,
          action: "whatsapp.queue.force",
          entity: "whatsapp_message",
          after: JSON.stringify({
            scanned: result.scanned,
            sent: result.sent,
            deferred: result.deferred,
            failed: result.failed,
            skippedScheduled: result.skippedScheduled,
            skippedRunning: result.skippedRunning,
            cancelled: result.cancelled,
          }),
        },
      })
      .catch(() => {});

    return jsonOk({ forced: result, ...(await queueDepth(orgId)), limits: QUEUE_LIMITS });
  } catch (err) {
    return handleApiError(err);
  }
}
