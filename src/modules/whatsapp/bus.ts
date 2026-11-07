import type { NormalizedEvent } from "./types";

/**
 * Barramento em memória dos eventos do WhatsApp (§19 do prompt).
 *
 * Papel exato: levar um evento que JÁ FOI PERSISTIDO no banco até as telas abertas.
 * Ele não grava nada e não é fonte de verdade — se o processo reinicia, quem manda é o
 * banco. Isso importa porque em dev o Next recarrega módulos o tempo todo: se a fila de
 * eventos fosse a memória do módulo, perderíamos eventos no hot reload.
 *
 * Duas pontas:
 *  - `ingest.ts` publica aqui depois de gravar a mensagem/conversa no banco;
 *  - `GET /api/whatsapp/events` (SSE) assina e repassa para o navegador.
 */

export type WaBusEvent =
  | NormalizedEvent
  | { type: "conversation.changed"; orgId: string; conversationId: string }
  | { type: "dashboard.changed"; orgId: string };

type Handler = (event: WaBusEvent) => void;

type BusState = {
  handlers: Map<string, Set<Handler>>;
  /** Contador global de eventos entregues — usado no log de diagnóstico e nos testes. */
  delivered: number;
};

const GLOBAL_KEY = "__whatsapp_bus__" as const;

function state(): BusState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { handlers: new Map<string, Set<Handler>>(), delivered: 0 };
  }
  const s: BusState = g[GLOBAL_KEY];
  s.handlers ??= new Map();
  return s;
}

/**
 * Publica para a org. Nunca lança: um assinante quebrado (ex.: uma resposta SSE que o
 * navegador fechou no meio) não pode derrubar o fluxo de entrada de mensagens.
 * Evento sem `orgId` é descartado — em um CRM multi-tenant não existe "para todos".
 */
export function publish(event: WaBusEvent): void {
  const orgId = event.orgId;
  if (!orgId) {
    console.warn(`[WhatsApp:bus] evento "${event.type}" sem orgId foi descartado.`);
    return;
  }
  const listeners = state().handlers.get(orgId);
  if (!listeners?.size) return;
  for (const handler of [...listeners]) {
    try {
      handler(event);
      state().delivered += 1;
    } catch (err) {
      console.error("[WhatsApp:bus] assinante falhou:", err);
    }
  }
}

/** Devolve a função de cancelamento — quem assina DEVE cancelar ao desconectar. */
export function subscribe(orgId: string, handler: Handler): () => void {
  const s = state();
  let set = s.handlers.get(orgId);
  if (!set) {
    set = new Set();
    s.handlers.set(orgId, set);
  }
  set.add(handler);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = state().handlers.get(orgId);
    current?.delete(handler);
    if (current && current.size === 0) state().handlers.delete(orgId);
  };
}

/** Quantos assinantes a org tem hoje (a UI de logs mostra "sessões assistindo ao vivo"). */
export function subscriberCount(orgId: string): number {
  return state().handlers.get(orgId)?.size ?? 0;
}

/** Formato de quadro SSE. O `id` permite ao navegador reconectar sem repetir evento. */
export function sseFrame(event: WaBusEvent, id?: string): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event.type}`, `data: ${JSON.stringify(event)}`, "");
  return `${lines.join("\n")}\n`;
}
