import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { getConversation, listMessages } from "@/modules/whatsapp/inbox";
import { sendMessage } from "@/modules/whatsapp/service";
import { expandShortcut } from "@/modules/whatsapp/engagement";
import { isMockEnabled, listProviders } from "@/modules/whatsapp/adapters";

/**
 * /api/whatsapp/messages — enviar e listar mensagens (§6/§7/§15).
 *
 * POST é o único caminho de saída do CRM: a rota não monta provedor, não escreve status
 * otimista e não conhece Baileys. Ela chama `WhatsAppService.sendMessage`, que faz guarda de
 * fila, conversa, INSERT, adapter e status real na ordem certa.
 */

/** GET — histórico com filtros (tela de mensagens, timeline, reenvio). */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const url = new URL(req.url);
    const { page, pageSize, skip, take } = parsePagination(url);

    const directionParam = url.searchParams.get("direction");
    const direction = directionParam === "IN" || directionParam === "OUT" ? directionParam : null;

    const { items, total } = await listMessages(orgId, {
      conversationId: url.searchParams.get("conversationId"),
      customerId: url.searchParams.get("customerId"),
      direction,
      status: url.searchParams.get("status"),
      search: url.searchParams.get("search"),
      take,
      skip,
    });

    return jsonOk({ items, total, page, pageSize, mock: isMockEnabled(), providers: listProviders() });
  } catch (err) {
    return handleApiError(err);
  }
}

const mediaSchema = z.object({
  kind: z.enum(["image", "video", "audio", "document"]),
  /** data URL (upload feito no navegador) ou URL http(s) acessível pelo servidor. */
  url: z.string().min(10).max(16_000_000),
  fileName: z.string().max(120).optional(),
  mimeType: z.string().max(80).optional(),
});

const postSchema = z
  .object({
    conversationId: z.string().optional(),
    phone: z.string().max(20).optional(),
    jid: z.string().max(120).optional(),
    customerId: z.string().optional(),
    body: z.string().max(4000).default(""),
    media: mediaSchema.optional(),
    templateKey: z.string().max(60).optional(),
    /** false = entra na fila espaçada (§26); padrão é enviar agora (chat interativo). */
    immediate: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.conversationId || v.phone || v.jid || v.customerId), {
    message: "Informe conversationId, phone ou jid.",
  })
  .refine((v) => Boolean(v.body.trim() || v.media), { message: "Escreva uma mensagem ou anexe uma mídia." });

/** POST — envia (ou enfileira) uma mensagem. */
export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    // Atalho de resposta rápida ("/ola") é expandido antes de sair (§7).
    const expanded = body.media ? { body: body.body, shortcut: null } : await expandShortcut(orgId, body.body);

    let conversationId = body.conversationId ?? null;
    let jid = body.jid ?? null;
    let phone = body.phone ?? null;
    let customerId = body.customerId ?? null;

    if (conversationId) {
      // A conversa é a fonte do destino real (jid pode ser @lid, que não é discável).
      const conversation = await getConversation(orgId, conversationId, 1);
      if (!conversation) return jsonOk({ error: "Conversa não encontrada." }, 404);
      jid = conversation.contact.jid;
      phone = conversation.contact.phone;
      customerId = conversation.customerId ?? customerId;
    }

    const outcome = await sendMessage({
      orgId,
      phone: jid ? null : phone,
      jid,
      customerId,
      conversationId,
      userId: session.userId,
      body: expanded.body,
      templateKey: body.templateKey,
      media: body.media,
      immediate: body.immediate ?? true,
    });

    if (!outcome.ok) {
      return jsonOk(
        {
          error: outcome.friendly ?? outcome.error ?? "Não foi possível enviar.",
          messageId: outcome.messageId,
          status: outcome.status,
        },
        502
      );
    }

    return jsonOk(outcome, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
