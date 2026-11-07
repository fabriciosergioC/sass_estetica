import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { deleteQuickReply, listQuickReplies, upsertQuickReply } from "@/modules/whatsapp/engagement";

/**
 * /api/whatsapp/quick-replies — respostas rápidas digitadas como `/atalho` na caixa de
 * mensagem (§7/§21). O corpo aceita as variáveis {{nome}} {{empresa}} {{telefone}} {{usuario}}.
 */

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const search = new URL(req.url).searchParams.get("search") ?? undefined;
    return jsonOk({ items: await listQuickReplies(orgId, search) });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.object({
  id: z.string().optional(),
  shortcut: z.string().min(1).max(30),
  title: z.string().max(60).nullable().optional(),
  body: z.string().min(1).max(2000),
});

/** POST — cria ou atualiza (com `id`) uma resposta rápida. */
export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());
    try {
      const reply = await upsertQuickReply({
        orgId,
        id: body.id ?? null,
        shortcut: body.shortcut,
        title: body.title ?? null,
        body: body.body,
      });
      return jsonOk({ reply }, 201);
    } catch (err) {
      return jsonOk({ error: err instanceof Error ? err.message : "Não foi possível salvar." }, 400);
    }
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE ?id= */
export async function DELETE(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonOk({ error: "Informe o id." }, 400);
    const ok = await deleteQuickReply(orgId, id);
    if (!ok) return jsonOk({ error: "Resposta rápida não encontrada." }, 404);
    return jsonOk({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
