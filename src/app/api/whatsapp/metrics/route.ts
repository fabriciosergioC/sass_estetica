import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { connectionMetrics, getConnectionView } from "@/modules/whatsapp/service";
import { queueDepth } from "@/modules/whatsapp/queue";

/**
 * GET /api/whatsapp/metrics — os indicadores do painel WhatsApp (§20).
 *
 * Retorna conversas abertas, respondidas, mensagens enviadas/recebidas hoje, taxa de
 * resposta, erros e fila. A taxa de resposta só conta conversa de cliente identificado:
 * número mascarado (@lid) não permite afirmar que a mesma pessoa respondeu.
 */
export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");

    const [view, metrics, queue, followUpsPending, byStatus] = await Promise.all([
      getConnectionView(orgId),
      connectionMetrics(orgId),
      queueDepth(orgId),
      db.whatsAppFollowUp.count({ where: { orgId, status: "PENDING" } }),
      db.whatsAppMessage.groupBy({ by: ["status"], where: { orgId, direction: "OUT" }, _count: { _all: true } }),
    ]);

    const delivered = byStatus
      .filter((r) => ["SENT", "DELIVERED", "READ"].includes(r.status))
      .reduce((acc, r) => acc + r._count._all, 0);
    const failed = byStatus.find((r) => r.status === "FAILED")?._count._all ?? 0;
    const outboundTotal = delivered + failed;

    return jsonOk({
      connection: { state: view.state, provider: view.provider, mock: view.mock, detail: view.detail },
      ...metrics,
      queue,
      followUpsPending,
      delivery: {
        delivered,
        failed,
        // % das saídas que o servidor do WhatsApp aceitou.
        successRate: outboundTotal ? Math.round((delivered / outboundTotal) * 100) : null,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
