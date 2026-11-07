import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { getConversation, listConversations, listTeam, type ConversationFilter } from "@/modules/whatsapp/inbox";
import { openConversation } from "@/modules/whatsapp/service";

/**
 * /api/whatsapp/conversations — a lista da coluna da esquerda (§4/§5) e o "Nova conversa".
 * Dados de leitura do nosso banco; nenhuma conversa é inventada aqui.
 */

const FILTERS: ConversationFilter[] = ["all", "appointments", "in_progress", "waiting", "done"];

/** GET ?filter=&search=&page=&pageSize= */
export async function GET(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const url = new URL(req.url);
    const { page, pageSize, skip, take } = parsePagination(url);

    const rawFilter = (url.searchParams.get("filter") ?? "all") as ConversationFilter;
    const filter = FILTERS.includes(rawFilter) ? rawFilter : "all";

    const [{ items, total }, team, unreadCount] = await Promise.all([
      listConversations(orgId, {
        filter,
        search: url.searchParams.get("search") ?? undefined,
        userId: session.userId,
        take,
        skip,
      }),
      listTeam(orgId),
      db.whatsAppConversation.aggregate({ where: { orgId, archived: false }, _sum: { unreadCount: true } }),
    ]);

    return jsonOk({
      items,
      total,
      page,
      pageSize,
      filter,
      filters: FILTERS,
      team,
      unreadTotal: unreadCount._sum.unreadCount ?? 0,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z
  .object({
    phone: z.string().min(10).max(20).optional(),
    jid: z.string().min(4).max(120).optional(),
    name: z.string().max(80).optional(),
    customerId: z.string().optional(),
  })
  .refine((v) => Boolean(v.phone || v.jid), { message: "Informe phone ou jid." });

/** POST — abre/retoma a conversa de um número (§8). */
export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    const result = await openConversation(orgId, body);
    if (!result.ok) return jsonOk({ error: result.friendly }, 400);

    const conversation = await getConversation(orgId, result.conversationId!, 20);
    return jsonOk({ ...result, conversation }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
