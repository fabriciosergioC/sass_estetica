import { formatPhone } from "@/lib/format";

/**
 * Vocabulário visual do módulo WhatsApp — compartilhado entre o painel de conversas e o
 * painel de conexão para que a mesma mensagem não apareça com rótulo diferente em duas telas.
 */

export type BadgeTone = "neutral" | "gold" | "green" | "red" | "blue" | "amber";

/**
 * O código interno vira legenda em português. "Enviada" = o servidor do WhatsApp aceitou
 * o texto (um risquinho); "Entregue" = o celular do destinatário confirmou (dois risquinhos).
 * "Aguardando servidor" = entregamos o texto no socket, mas o WhatsApp ainda não respondeu
 * nada — se a mensagem ficar nesse estado, ela NÃO saiu do nosso lado.
 */
export const MSG_LABEL: Record<string, string> = {
  QUEUED: "Na fila",
  PENDING: "Aguardando servidor",
  SENT: "Enviada",
  DELIVERED: "Entregue",
  READ: "Lida",
  RECEIVED: "Recebida",
  FAILED: "Falhou",
  CANCELLED: "Cancelada",
};

export const MSG_TONE: Record<string, BadgeTone> = {
  QUEUED: "amber",
  PENDING: "amber",
  SENT: "green",
  DELIVERED: "green",
  READ: "green",
  RECEIVED: "blue",
  FAILED: "red",
  CANCELLED: "neutral",
};

/** Estados da conexão (§2). A tela nunca mostra o código cru ao usuário. */
export const CONNECTION_LABEL: Record<string, string> = {
  DISCONNECTED: "Desconectado",
  CONNECTING: "Conectando",
  WAITING_QR: "Aguardando QR Code",
  CONNECTED: "Conectado",
  RECONNECT_REQUIRED: "Reconexão necessária",
  ERROR: "Erro",
  // O provedor Baileys ainda usa PENDING_QR no estado interno gravado.
  PENDING_QR: "Aguardando QR Code",
};

export const CONNECTION_TONE: Record<string, BadgeTone> = {
  DISCONNECTED: "amber",
  CONNECTING: "blue",
  WAITING_QR: "blue",
  PENDING_QR: "blue",
  CONNECTED: "green",
  RECONNECT_REQUIRED: "amber",
  ERROR: "red",
};

export const STATUS_LABEL: Record<string, string> = {
  OPEN: "Aberta",
  IN_PROGRESS: "Em atendimento",
  WAITING_CUSTOMER: "Aguardando resposta",
  DONE: "Finalizada",
};

export const FILTER_LABEL: Record<string, string> = {
  all: "Todas",
  appointments: "Agendamentos",
  in_progress: "Em atendimento",
  waiting: "Aguardando resposta",
  done: "Finalizadas",
};

/**
 * Rótulo do telefone na lista. O WhatsApp hoje entrega o remetente mascarado como @lid
 * (um identificador longo, que NÃO é número) quando ele não está na agenda do aparelho
 * pareado — imprimir aqueles dígitos como se fossem telefone só confunde quem olha a tela.
 */
export function phoneLabel(phone: string | null | undefined): string {
  if (!phone) return "sem número";
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 14) return "número protegido pelo WhatsApp";
  return formatPhone(phone);
}

/** Hora curta (HH:mm) para as bolhas; data completa só quando o dia mudou. */
export function shortTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Hoje";
  if (same(d, yesterday)) return "Ontem";
  return d.toLocaleDateString("pt-BR");
}

/** Prévia de uma linha do histórico, sem deixar o `[unknown]` cru na tela. */
export function previewBody(body: string | null | undefined): string {
  if (!body) return "(sem texto)";
  return body.replace(/^\[unknown\]\s*/, "").trim() || "(sem texto)";
}
