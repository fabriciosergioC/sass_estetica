import { NextRequest } from "next/server";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { listLogs } from "@/modules/whatsapp/engagement";
import { subscriberCount } from "@/modules/whatsapp/bus";

/**
 * GET /api/whatsapp/logs — a trilha de eventos do módulo (§24).
 *
 * O que entra aqui é escrito por `logWa`, que redige segredo antes de gravar: nunca token,
 * chave de sessão, QR ou payload cru do WhatsApp. É por isso que a tela pode ser aberta por
 * qualquer ADMIN sem virar um vazamento.
 */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const url = new URL(req.url);
    const { page, pageSize, skip, take } = parsePagination(url);

    const { items, total } = await listLogs(orgId, {
      level: url.searchParams.get("level") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      take,
      skip,
    });

    return jsonOk({ items, total, page, pageSize, liveViewers: subscriberCount(orgId) });
  } catch (err) {
    return handleApiError(err);
  }
}
