import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import {
  connect,
  connectionMetrics,
  disconnect,
  getConnectionView,
  setProvider,
} from "@/modules/whatsapp/service";
import { listProviders } from "@/modules/whatsapp/adapters";
import { queueDepth } from "@/modules/whatsapp/queue";
import { logWa } from "@/modules/whatsapp/logs";

/**
 * /api/whatsapp — a porta de entrada da conexão (§2, §15).
 *
 * A rota não escolhe provedor nem fala com o socket: ela chama o WhatsAppService, que decide
 * o adapter. É o que impede o bug antigo de cada rota montar um provider por conta própria.
 */

/** GET — estado da conexão + histórico recente + fila + indicadores do painel (§20). */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const url = new URL(req.url);
    const { skip, take, page, pageSize } = parsePagination(url);
    const wantMessages = url.searchParams.get("messages") !== "0";

    const [view, metrics, queue] = await Promise.all([
      getConnectionView(orgId),
      connectionMetrics(orgId),
      queueDepth(orgId),
    ]);

    const where = { orgId };
    const [messages, total, failed] = await Promise.all([
      wantMessages
        ? db.whatsAppMessage.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip,
            take,
            include: { customer: { select: { name: true } } },
          })
        : Promise.resolve([]),
      db.whatsAppMessage.count({ where }),
      db.whatsAppMessage.count({ where: { orgId, status: "FAILED" } }),
    ]);

    return jsonOk({
      connection: {
        id: view.connectionId,
        provider: view.provider,
        /** A tela antiga usa esta flag para saber se deve ficar buscando QR a cada 3s. */
        baileys: view.provider === "BARIELS" || view.mock,
        mock: view.mock,
        // `status` é o último estado gravado; `liveStatus` é o estado real do processo agora.
        // A UI deve confiar em liveStatus.
        status: view.savedStatus,
        liveStatus: view.state,
        detail: view.detail,
        phone: view.phone,
        accountName: view.accountName,
        lastSyncAt: view.lastSyncAt,
      },
      view,
      messages,
      total,
      failed,
      page,
      pageSize,
      metrics,
      queue,
      providers: listProviders(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["connect", "disconnect", "reconnect"]), freshQr: z.boolean().optional() }),
  z.object({ action: z.literal("set_provider"), provider: z.string().min(2).max(30) }),
]);

/** POST — conecta/desconecta/reconecta ou troca o provedor desta barbearia. */
export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    if (body.action === "set_provider") {
      const result = await setProvider(orgId, body.provider);
      if (!result.ok) return jsonOk({ error: result.friendly }, 400);
      return jsonOk({ view: await getConnectionView(orgId), provider: result.provider });
    }

    const before = await db.whatsAppConnection.findUnique({ where: { orgId } });

    // connect   → retoma a sessão salva; se não existir ou não valer, gera QR.
    // reconnect → descarta a sessão salva e garante um QR novo.
    const freshQr = body.action === "reconnect" || (body.action === "connect" && body.freshQr === true);

    const view =
      body.action === "disconnect"
        ? await disconnect(orgId)
        : await connect(orgId, { freshQr });

    await db.auditLog
      .create({
        data: {
          orgId,
          userId: session.userId,
          action: `whatsapp.${body.action}`,
          entity: "whatsapp_connection",
          entityId: view.connectionId,
          before: JSON.stringify({ status: before?.status ?? null }),
          after: JSON.stringify({ status: view.state, detail: view.detail }),
        },
      })
      .catch((err) => console.error("[api/whatsapp] audit falhou:", err));

    if (view.state === "ERROR") {
      await logWa({ orgId, level: "error", event: `connection.${body.action}`, detail: view.detail });
      return jsonOk({ error: view.detail ?? "Não foi possível conectar.", view }, 400);
    }

    return jsonOk({
      connection: {
        id: view.connectionId,
        provider: view.provider,
        baileys: view.provider === "BARIELS" || view.mock,
        status: view.savedStatus,
        liveStatus: view.state,
        detail: view.detail,
        phone: view.phone,
      },
      view,
      liveStatus: view.state,
      detail: view.detail,
      qrAvailable: Boolean(view.qr),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
