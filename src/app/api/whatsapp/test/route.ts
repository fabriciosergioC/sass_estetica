import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/phone";
import { sendMessage, testConnection } from "@/modules/whatsapp/service";
import { getConversation } from "@/modules/whatsapp/inbox";

/**
 * /api/whatsapp/test — os dois sentidos do "testar" (§30).
 *
 *  { action: "connection" } → checklist honesto (API, sessão, instância, conectado, tempo
 *  real). Não envia nada: é o que o botão "Testar conexão" mostra.
 *  { phone, message }       → mensagem de teste real, agora pelo MESMO caminho do chat e do
 *  job agendado (WhatsAppService → adapter). Antes a rota montava um provider por conta
 *  própria, e o que funcionava aqui podia estar quebrado na automação.
 */

const schema = z.object({
  action: z.literal("connection").optional(),
  phone: z.string().min(10).max(20).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  conversationId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const body = schema.parse(await req.json());

    if (body.action === "connection") {
      const result = await testConnection(orgId);
      return jsonOk({ ...result, checkedAt: new Date().toISOString() });
    }

    if (!body.phone || !body.message) {
      return jsonOk({ error: "Informe telefone e mensagem, ou use { action: \"connection\" }." }, 400);
    }

    const phone = normalizePhone(body.phone);
    if (!phone) return jsonOk({ error: "Telefone inválido." }, 400);

    // Quando a conversa existe, enviamos pelo jid dela: é assim que um contato mascarado
    // (@lid) recebe o teste na conversa certa em vez de abrir um chat novo.
    const existing = body.conversationId ? await getConversation(orgId, body.conversationId, 1) : null;
    const jid = existing?.contact?.jid ?? null;

    const outcome = await sendMessage({
      orgId,
      phone: jid ? null : phone,
      jid,
      body: body.message,
      customerId: existing?.customerId ?? null,
      conversationId: existing?.id ?? null,
      userId: session.userId,
      immediate: true,
    });

    const stored = outcome.messageId
      ? await db.whatsAppMessage.findUnique({ where: { id: outcome.messageId } })
      : null;

    await db.auditLog
      .create({
        data: {
          orgId,
          userId: session.userId,
          action: "whatsapp.test",
          entity: "whatsapp_message",
          entityId: outcome.messageId || null,
          after: JSON.stringify({ phone, status: outcome.status, error: outcome.error ?? null }),
        },
      })
      .catch(() => {});

    if (!outcome.ok) {
      return jsonOk(
        {
          ok: false,
          messageId: outcome.messageId,
          status: stored?.status ?? outcome.status,
          providerMsgId: stored?.providerMsgId ?? null,
          error: outcome.friendly ?? outcome.error ?? "Não foi possível enviar.",
        },
        502
      );
    }

    return jsonOk(
      {
        ok: true,
        messageId: outcome.messageId,
        conversationId: outcome.conversationId,
        status: stored?.status ?? outcome.status,
        providerMsgId: stored?.providerMsgId ?? null,
        error: null,
        // SENT aqui = o servidor do WhatsApp aceitou o texto (um risquinho). A entrega no
        // celular chega sozinha como DELIVERED quando o destinatário responde o recibo.
        note:
          stored?.status === "PENDING"
            ? "Entregue no socket, mas o WhatsApp ainda não respondeu o <ack>. Se ficar assim, a mensagem não saiu do nosso lado."
            : "Aceito pelo servidor do WhatsApp. Fica SENT até o celular do destinatário confirmar entrega.",
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}
