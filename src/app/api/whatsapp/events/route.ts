import { NextRequest } from "next/server";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { sseFrame, subscribe, type WaBusEvent } from "@/modules/whatsapp/bus";
import { getConnectionView } from "@/modules/whatsapp/service";

/**
 * GET /api/whatsapp/events — tempo real (§19) via Server-Sent Events.
 *
 * SSE e não WebSocket porque o navegador reconecta sozinho, passa pelo mesmo cookie de
 * sessão do resto do CRM e não exige servidor de proxy configurado. O evento vem do
 * barramento interno (`bus.ts`), que é alimentado pelo ingest — a tela não pulsa fetch.
 *
 * Filtro opcional: ?topics=message.upsert,conversation.changed
 */
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    ({ orgId } = await requirePermission("whatsapp:manage"));
  } catch (err) {
    return handleApiError(err);
  }

  const topicsParam = new URL(req.url).searchParams.get("topics");
  const topics = topicsParam ? new Set(topicsParam.split(",").map((t) => t.trim()).filter(Boolean)) : null;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let seq = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* navegador fechou a conexão no meio do quadro */
        }
      };

      // Quadro inicial: o cliente já parte do estado certo sem uma chamada extra.
      write(`event: ready\ndata: ${JSON.stringify({ orgId, at: new Date().toISOString() })}\n\n`);

      void getConnectionView(orgId)
        .then((view) => write(`event: connection\ndata: ${JSON.stringify(view)}\n\n`))
        .catch(() => {});

      unsubscribe = subscribe(orgId, (event: WaBusEvent) => {
        if (topics && !topics.has(event.type)) return;
        seq += 1;
        write(sseFrame(event, `${Date.now()}-${seq}`));
      });

      // Comentário periódico: sem tráfego, proxy e navegador derrubam a conexão silenciosa.
      heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), 20_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  req.signal.addEventListener("abort", () => {
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
