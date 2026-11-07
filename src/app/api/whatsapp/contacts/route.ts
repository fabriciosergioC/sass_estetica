import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { listContacts } from "@/modules/whatsapp/inbox";
import { openConversation } from "@/modules/whatsapp/service";

/**
 * /api/whatsapp/contacts — a agenda do módulo (§8).
 *
 * Contato do WhatsApp NÃO é cliente do CRM: é quem falou (ou pode falar) pelo número. A
 * ligação `customerId` acontece quando o número bate com um cadastro ou quando o atendente
 * cria o lead a partir da conversa.
 */

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const url = new URL(req.url);
    const { page, pageSize, skip, take } = parsePagination(url);

    const { items, total } = await listContacts(orgId, {
      search: url.searchParams.get("search") ?? undefined,
      take,
      skip,
    });

    return jsonOk({
      items: items.map((c) => ({
        id: c.id,
        jid: c.jid,
        phone: c.phone,
        name: c.name,
        masked: c.masked,
        source: c.source,
        firstSeenAt: c.firstSeenAt,
        lastSeenAt: c.lastSeenAt,
        customerId: c.customerId,
        customer: c.customer ?? null,
        conversationId: c.conversations[0]?.id ?? null,
        unreadCount: c.conversations[0]?.unreadCount ?? 0,
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z
  .object({
    phone: z.string().min(10).max(20).optional(),
    jid: z.string().max(120).optional(),
    name: z.string().max(80).optional(),
    customerId: z.string().optional(),
  })
  .refine((v) => Boolean(v.phone || v.jid), { message: "Informe phone ou jid." });

/** POST — cadastra/atualiza um contato na agenda, sem enviar nada. */
export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());
    const result = await openConversation(orgId, body);
    if (!result.ok) return jsonOk({ error: result.friendly }, 400);
    return jsonOk(result, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
