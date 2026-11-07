// Diagnóstico de conexão SEM sessão de browser: devolve o estado vivo de cada provedor
// (o mesmo que a tela de WhatsApp lê como `liveStatus`), o snapshot do QR, o estado da fila
// e o tamanho do backlog de mensagens. Protegido por CRON_SECRET (header x-cron-secret).
//
//   curl -H "x-cron-secret: <CRON_SECRET>" http://localhost:3000/api/whatsapp/status
//
// Este endpoint NÃO envia nada e NÃO altera estado: ele lê. A única escrita é eventual,
// dentro do adapter, quando ele mesmo decide subir um socket para responder.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { getAdapter, isMockEnabled, listProviders } from "@/modules/whatsapp/adapters";
import { QUEUE_LIMITS, pauseInfo, queueDepth } from "@/modules/whatsapp/queue";
import { getWorkerStatus } from "@/modules/automation/worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret");
  if (!secret || provided !== secret) return jsonOk({ error: "Não autorizado." }, 401);

  const conns = await db.whatsAppConnection.findMany({
    select: {
      id: true,
      orgId: true,
      provider: true,
      status: true,
      phone: true,
      lastSyncAt: true,
      org: { select: { name: true } },
    },
  });

  // Cada org é sondada pelo SEU provider declarado — nunca pelo provider "do momento", que
  // é justamente o que fazia uma barbearia aparecer conectada com o QR de outra.
  const probes = await Promise.all(
    conns.map(async (conn) => {
      const adapter = getAdapter(conn.provider);
      let live: Record<string, unknown> = {};
      let error: string | null = null;
      try {
        live = await adapter.getStatus({ orgId: conn.orgId, connectionId: conn.id });
      } catch (err: any) {
        error = err?.friendly ?? err?.message ?? String(err);
        live = { state: "ERROR", detail: error };
      }
      const [depth, pause] = await Promise.all([queueDepth(conn.orgId), pauseInfo(conn.orgId)]);
      return {
        org: conn.org?.name,
        orgId: conn.orgId,
        provider: adapter.name,
        mock: adapter.mock,
        dbStatus: conn.status,
        phone: conn.phone,
        lastSyncAt: conn.lastSyncAt,
        live,
        queue: depth,
        pause,
        error,
      };
    })
  );

  const [jobs, msgs, unread, qr] = await Promise.all([
    db.job.groupBy({ by: ["status"], _count: { _all: true } }).catch(() => []),
    db.whatsAppMessage.groupBy({ by: ["status"], where: { direction: "OUT" }, _count: { _all: true } }),
    db.whatsAppMessage.count({ where: { direction: "IN", conversationId: null } }),
    // Snapshot do socket em memória: diz QUAL org é dona dele agora (diagnóstico de tenancy).
    import("@/modules/whatsapp/baileys/provider")
      .then((m) => m.baileysSnapshot(conns[0]?.orgId ?? ""))
      .catch(() => null),
  ]);

  return jsonOk({
    worker: getWorkerStatus(),
    env: {
      WHATSAPP_PROVIDER: process.env.WHATSAPP_PROVIDER ?? null,
      WHATSAPP_MOCK: process.env.WHATSAPP_MOCK ?? null,
      WHATSAPP_USE_LID: process.env.WHATSAPP_USE_LID ?? null,
      WHATSAPP_DEFAULT_DDI: process.env.WHATSAPP_DEFAULT_DDI ?? null,
      BAILEYS_AUTO_CONNECT: process.env.BAILEYS_AUTO_CONNECT ?? null,
      BAILEYS_LOG_LEVEL: process.env.BAILEYS_LOG_LEVEL ?? null,
      mockEnabled: isMockEnabled(),
    },
    limits: QUEUE_LIMITS,
    providers: listProviders(),
    // ownerOrgId diferente de null = existe um socket vivo e a quem ele pertence.
    socket: qr
      ? {
          ownerOrgId: qr.ownerOrgId,
          hasSocket: qr.hasSocket,
          state: qr.state?.status ?? null,
          detail: qr.state?.detail ?? null,
          account: qr.account,
          reconnectAttempts: qr.reconnectAttempts,
          lastStatusCode: qr.lastStatusCode,
          qrAgeMs: qr.qr?.ageMs ?? null,
        }
      : null,
    connections: probes,
    jobs,
    mensagensOut: msgs,
    mensagensSemConversa: unread,
  });
}
