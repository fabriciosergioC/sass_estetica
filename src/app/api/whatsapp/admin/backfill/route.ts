import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { backfillHistory } from "@/modules/whatsapp/service";
import { reconcileQueuedSends } from "@/modules/whatsapp/queue";

/**
 * POST /api/whatsapp/admin/backfill — traz as mensagens antigas (sem conversa) para o
 * painel de conversas (§12) e destrava mensagens presas em "aguardando" (§26).
 *
 * Autorização dupla, de propósito:
 *  - sessão de ADMIN do CRM (o botão "Reorganizar histórico" da tela); ou
 *  - header `x-cron-secret` com o CRON_SECRET, para rodar por linha de comando
 *    (`?orgId=` opcional; sem ele, percorre as barbearias que têm mensagens órfãs).
 *
 * Não envia nada e não reescreve corpo de mensagem: só cria contato/conversa a partir do
 * número já gravado e aponta cada mensagem para ela. Pode rodar mais de uma vez.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret");

  if (secret && provided === secret) {
    const asked = url.searchParams.get("orgId");
    if (asked) {
      const org = await db.organization.findFirst({ where: { id: asked }, select: { id: true } });
      if (!org) return jsonOk({ error: "orgId não encontrado." }, 404);
      return jsonOk({
        viaSecret: true,
        orgId: org.id,
        ...(await backfillHistory(org.id)),
        reconciled: await reconcileQueuedSends(org.id),
      });
    }

    const rows = await db.whatsAppMessage.findMany({
      where: { conversationId: null },
      distinct: ["orgId"],
      select: { orgId: true },
    });
    const results = [];
    for (const row of rows) results.push({ orgId: row.orgId, ...(await backfillHistory(row.orgId)) });
    return jsonOk({ viaSecret: true, allOrgs: true, results });
  }

  let orgId: string;
  try {
    ({ orgId } = await requirePermission("whatsapp:manage"));
  } catch (err) {
    return handleApiError(err);
  }

  return jsonOk(await backfillHistory(orgId));
}
