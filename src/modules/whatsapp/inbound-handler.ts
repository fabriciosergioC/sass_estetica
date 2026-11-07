import type { AdapterContext, WhatsAppAdapter } from "./adapter";
import { ingestEvent } from "./ingest";

/**
 * Ponte entre adapters que ENTREGAM eventos por callback (mock, e qualquer API HTTP com
 * websocket no futuro) e o escritor único do histórico.
 *
 * O Bariels não precisa disto: o socket dele já chama `ingestEvent` diretamente, porque o
 * evento nasce dentro do mesmo módulo. Manter os dois caminhos explícitos evita o pior
 * cenário, que é mensagem recebida e não gravada porque "ninguém estava assinando".
 */
export function attachInboundHandler(adapter: WhatsAppAdapter, ctx: AdapterContext): void {
  if (!adapter.attachEventHandler) return;

  adapter.attachEventHandler(ctx, (event) => {
    void ingestEvent({ ...event, orgId: ctx.orgId } as typeof event).catch((err) =>
      console.error(`[WhatsApp:inbound] falha ao processar ${event.type}:`, err)
    );
  });
}

export function detachInboundHandler(adapter: WhatsAppAdapter, ctx: AdapterContext): void {
  adapter.detachEventHandler?.(ctx);
}
