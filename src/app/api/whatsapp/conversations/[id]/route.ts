import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import {
  archiveConversation,
  assignConversation,
  createCustomerFromConversation,
  getConversation,
  linkConversationCustomer,
  markConversationRead,
  setConversationStatus,
} from "@/modules/whatsapp/inbox";

/**
 * /api/whatsapp/conversations/[id] — a coluna do meio (§6) e as ações do cabeçalho (§5/§9).
 * Tudo aqui é leitura/organização do que já está gravado; enviar mensagem é
 * POST /api/whatsapp/messages, que passa pelo WhatsAppService.
 */

const CONVERSATION_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "DONE"];

/** GET — conversa + mensagens. `?markRead=1` zera o não lido (a tela chama ao abrir). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const { id } = await params;
    const url = new URL(req.url);
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 100) || 100);

    const conversation = await getConversation(orgId, id, limit);
    if (!conversation) return jsonOk({ error: "Conversa não encontrada." }, 404);

    if (url.searchParams.get("markRead") === "1") await markConversationRead(orgId, id);

    return jsonOk({ conversation });
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z
  .object({
    status: z.enum(CONVERSATION_STATUSES as [string, ...string[]]).optional(),
    assigneeId: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    customerId: z.string().nullable().optional(),
    markRead: z.boolean().optional(),
    createLead: z
      .object({ name: z.string().min(1).max(80), phone: z.string().max(20).nullable().optional() })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para atualizar." });

/** PATCH — status, responsável, arquivar, vincular lead, criar lead (§8/§9). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const { id } = await params;
    const body = patchSchema.parse(await req.json());

    if (body.markRead) await markConversationRead(orgId, id);
    if (body.status) {
      const updated = await setConversationStatus(orgId, id, body.status, session.userId);
      if (!updated) return jsonOk({ error: "Conversa não encontrada." }, 404);
    }
    if (body.assigneeId !== undefined) await assignConversation(orgId, id, body.assigneeId);
    if (body.archived !== undefined) await archiveConversation(orgId, id, body.archived);

    if (body.customerId !== undefined) {
      const linked = await linkConversationCustomer(orgId, id, body.customerId);
      if (!linked) return jsonOk({ error: "Conversa ou cliente não encontrado." }, 400);
    }

    let lead = null as { id: string; name: string; phone: string } | null;
    if (body.createLead) {
      // Contatos mascarados (@lid) não têm número: criar lead deles geraria cliente falso.
      try {
        const created = await createCustomerFromConversation({
          orgId,
          conversationId: id,
          name: body.createLead.name,
          phone: body.createLead.phone ?? null,
          userId: session.userId,
        });
        if (!created) return jsonOk({ error: "Conversa não encontrada." }, 404);
        lead = created.customer;
      } catch (err) {
        return jsonOk({ error: err instanceof Error ? err.message : "Não foi possível criar o lead." }, 400);
      }
    }

    const conversation = await getConversation(orgId, id, 60);
    return jsonOk({ conversation, lead });
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE — arquiva (nunca apaga: histórico do WhatsApp é prova de atendimento). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const { id } = await params;
    const ok = await archiveConversation(orgId, id, true);
    if (!ok) return jsonOk({ error: "Conversa não encontrada." }, 404);
    return jsonOk({ archived: true });
  } catch (err) {
    return handleApiError(err);
  }
}
