import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { completeFollowUp, listFollowUps, scheduleFollowUp } from "@/modules/whatsapp/engagement";

/**
 * /api/whatsapp/follow-ups — "cobrar depois" (§23).
 * Agendar cria um lembrete para o responsável na hora marcada; o lembrete é um job comum,
 * então sobrevive a restart e aparece na central de notificações do CRM.
 */

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const status = new URL(req.url).searchParams.get("status") ?? "PENDING";
    return jsonOk({ items: await listFollowUps(orgId, status) });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.object({
  conversationId: z.string().optional(),
  customerId: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  scheduledAt: z.string().min(4),
  reason: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    const scheduledAt = new Date(body.scheduledAt);
    try {
      const followUp = await scheduleFollowUp({
        orgId,
        conversationId: body.conversationId ?? null,
        customerId: body.customerId ?? null,
        assigneeId: body.assigneeId ?? null,
        scheduledAt,
        reason: body.reason,
      });
      return jsonOk({ followUp }, 201);
    } catch (err) {
      return jsonOk({ error: err instanceof Error ? err.message : "Não foi possível agendar." }, 400);
    }
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z.object({ id: z.string().min(1), status: z.enum(["DONE", "CANCELLED"]).default("DONE") });

/** PATCH — conclui ou cancela o follow-up. */
export async function PATCH(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = patchSchema.parse(await req.json());
    const ok = await completeFollowUp(orgId, body.id, body.status);
    if (!ok) return jsonOk({ error: "Follow-up não encontrado." }, 404);
    return jsonOk({ updated: true });
  } catch (err) {
    return handleApiError(err);
  }
}
