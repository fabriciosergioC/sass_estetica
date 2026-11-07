import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import {
  subscribeAppointmentEvents,
  sseAppointmentFrame,
  type AppointmentBusEvent,
} from "@/modules/scheduling/appointments-bus";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(req: NextRequest) {
  let orgId: string;
  try {
    ({ orgId } = await requirePermission("appointments:read"));
  } catch (err) {
    return handleApiError(err);
  }

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let seq = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* navegador fechou conexão */
        }
      };

      // Quadro inicial de conexão
      write(`event: ready\ndata: ${JSON.stringify({ orgId, at: new Date().toISOString() })}\n\n`);

      unsubscribe = subscribeAppointmentEvents(orgId, (event: AppointmentBusEvent) => {
        seq += 1;
        write(sseAppointmentFrame(event, `${Date.now()}-${seq}`));
      });

      // Keepalive ping para evitar timeout de proxies/navegadores
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
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
