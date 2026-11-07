import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { resendMessage } from "@/modules/whatsapp/service";

/**
 * /api/whatsapp/messages/[id] — GET de uma mensagem e POST de ação (reenvio, §7/§26).
 *
 * O reenvio volta pela MESMA linha e pelo MESMO caminho da fila: passa de novo por pausa,
 * limite por hora, bloqueio e opt-out. Não existe atalho "mandar agora sem checar".
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const { id } = await params;
    const message = await db.whatsAppMessage.findFirst({ where: { id, orgId } });
    if (!message) return jsonOk({ error: "Mensagem não encontrada." }, 404);
    return jsonOk({ message });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.object({ action: z.enum(["resend"]) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const { id } = await params;
    const body = postSchema.parse(await req.json());

    if (body.action === "resend") {
      const outcome = await resendMessage(orgId, id);
      await db.auditLog
        .create({
          data: {
            orgId,
            userId: session.userId,
            action: "whatsapp.message.resend",
            entity: "whatsapp_message",
            entityId: outcome.messageId,
            after: JSON.stringify({ status: outcome.status, error: outcome.error ?? null }),
          },
        })
        .catch(() => {});

      if (!outcome.ok) {
        return jsonOk(
          {
            error: outcome.friendly ?? outcome.error ?? "Não foi possível reenviar.",
            messageId: outcome.messageId,
            status: outcome.status,
          },
          502
        );
      }
      return jsonOk(outcome, 201);
    }

    return jsonOk({ error: "Ação não reconhecida." }, 400);
  } catch (err) {
    return handleApiError(err);
  }
}
