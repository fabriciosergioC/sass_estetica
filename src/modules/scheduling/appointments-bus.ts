/**
 * Barramento em memória de eventos de agendamentos e status da Agenda.
 * Leva as mudanças de agendamento em tempo real para as telas abertas via SSE.
 */

export type AppointmentBusEvent = {
  type: "appointment.updated" | "appointment.created" | "appointment.deleted";
  orgId: string;
  appointmentId: string;
  status: string;
  startAt?: string;
  endAt?: string;
  barberId?: string;
  customerId?: string;
  at: string;
};

type Handler = (event: AppointmentBusEvent) => void;

type BusState = {
  handlers: Map<string, Set<Handler>>;
  delivered: number;
};

const GLOBAL_KEY = "__appointments_bus__" as const;

function state(): BusState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { handlers: new Map<string, Set<Handler>>(), delivered: 0 };
  }
  const s: BusState = g[GLOBAL_KEY];
  s.handlers ??= new Map();
  return s;
}

/** Formata quadro SSE padrão text/event-stream. */
export function sseAppointmentFrame(event: AppointmentBusEvent, id?: string): string {
  const lines: string[] = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return lines.join("\n") + "\n\n";
}

/**
 * Publica evento de agendamento para a organização especificada.
 */
export function publishAppointmentEvent(event: AppointmentBusEvent): void {
  const orgId = event.orgId;
  if (!orgId) return;
  const listeners = state().handlers.get(orgId);
  if (!listeners?.size) return;
  for (const handler of [...listeners]) {
    try {
      handler(event);
      state().delivered += 1;
    } catch (err) {
      console.error("[Appointments:bus] assinante falhou:", err);
    }
  }
}

/**
 * Assina eventos de agendamentos da organização.
 * Retorna função para cancelar assinatura.
 */
export function subscribeAppointmentEvents(orgId: string, handler: Handler): () => void {
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
