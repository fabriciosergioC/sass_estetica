import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { QUEUE_LIMITS, pauseInfo, queueDepth, resumeSending, pauseSending } from "@/modules/whatsapp/queue";
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
  action: z.enum(["pause", "resume"]),
  reason: z.string().max(200).optional(),
  minutes: z.number().int().min(1).max(1440).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    if (body.action === "pause") {
      await pauseSending(orgId, body.reason ?? "Pausado manualmente pelo painel", body.minutes);
    } else {
      await resumeSending(orgId, session.userId);
    }

    return jsonOk({ ...(await queueDepth(orgId)), limits: QUEUE_LIMITS });
  } catch (err) {
    return handleApiError(err);
  }
}
