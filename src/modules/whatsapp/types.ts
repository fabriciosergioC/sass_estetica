/**
 * Vocabulário canônico da integração de WhatsApp.
 *
 * Por que isso existe: o prompt de integração fala `incoming/outgoing` e
 * `pending|sent|delivered|read|failed`, mas o banco deste projeto já grava
 * `OUT|IN` e `QUEUED|PENDING|SENT|DELIVERED|READ|FAILED|CANCELLED|RECEIVED` em 55 linhas
 * históricas. Trocar o vocabulário do banco quebraria dados e todo o resto do código, então
 * traduzimos na borda (aqui) e mantemos o banco como está.
 *
 * Nada fora de `src/modules/whatsapp` deve conhecer os tipos crus do provedor (Baileys,
 * Evolution, Cloud API): eles entram por `NormalizedEvent` e saem por cá.
 */

export type Direction = "incoming" | "outgoing";

export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "unknown";

/** Estados da tela de conexão (§2 do prompt). Identificador em inglês, rótulo em português. */
export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "WAITING_QR"
  | "CONNECTED"
  | "RECONNECT_REQUIRED"
  | "ERROR";

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  DISCONNECTED: "Desconectado",
  CONNECTING: "Conectando",
  WAITING_QR: "Aguardando QR Code",
  CONNECTED: "Conectado",
  RECONNECT_REQUIRED: "Reconexão necessária",
  ERROR: "Erro",
};

export const CONNECTION_TONE: Record<
  ConnectionState,
  "neutral" | "gold" | "green" | "red" | "blue" | "amber"
> = {
  DISCONNECTED: "neutral",
  CONNECTING: "blue",
  WAITING_QR: "gold",
  CONNECTED: "green",
  RECONNECT_REQUIRED: "amber",
  ERROR: "red",
};

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: "Aguardando servidor",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

/** status do banco → status canônico. `QUEUED`/`RECEIVED` não têm par direto. */
export function toCanonicalStatus(status: string | null | undefined): DeliveryStatus | "queued" | "received" | "cancelled" {
  switch ((status ?? "").toUpperCase()) {
    case "QUEUED":
      return "queued";
    case "PENDING":
      return "pending";
    case "SENT":
      return "sent";
    case "DELIVERED":
      return "delivered";
    case "READ":
      return "read";
    case "FAILED":
      return "failed";
    case "RECEIVED":
      return "received";
    case "CANCELLED":
      return "cancelled";
    default:
      return "pending";
  }
}

/** status canônico → status do banco. */
export function toDbStatus(status: DeliveryStatus | "queued" | "received" | "cancelled"): string {
  switch (status) {
    case "queued":
      return "QUEUED";
    case "pending":
      return "PENDING";
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    case "received":
      return "RECEIVED";
    case "cancelled":
      return "CANCELLED";
  }
}

export function toCanonicalDirection(direction: string): Direction {
  return direction === "IN" ? "incoming" : "outgoing";
}

export function toDbDirection(direction: Direction): "IN" | "OUT" {
  return direction === "incoming" ? "IN" : "OUT";
}

/**
 * Ranks de status, para nunca rebaixarmos uma mensagem já entregue/lida quando chega um
 * ack fora de ordem (acontece: o <receipt> de leitura pode ser processado antes do de entrega).
 */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  PENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

export function canAdvanceStatus(from: string | null | undefined, to: string): boolean {
  if (!from) return true;
  if (from === "FAILED") return false; // falhou é terminal; recibo posterior seria outro envio
  return (STATUS_RANK[from] ?? -1) < (STATUS_RANK[to] ?? -1);
}

// ─── Eventos normalizados (§11) ──────────────────────────────────────────────

export type NormalizedMessage = {
  /** jid do par (telefone ou @lid). É a chave real do WhatsApp. */
  jid: string;
  /**
   * O outro domínio do MESMO par, quando o WhatsApp manda (`remoteJidAlt`): conversa
   * endereçada por @lid traz o número em `@s.whatsapp.net` e vice-versa. É o que permite
   * juntar as duas identidades numa pessoa só em vez de abrir segunda conversa.
   */
  altJid?: string | null;
  /** telefone internacional quando o WhatsApp não mascarou (jid @lid → null). */
  phone: string | null;
  masked: boolean;
  direction: Direction;
  messageType: MessageType;
  text: string;
  providerMsgId: string;
  /** segundos epoc, como o WhatsApp manda no atributo `t`. */
  timestampSec?: number;
  pushName?: string | null;
  media?: {
    kind: MessageType;
    url?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    sizeBytes?: number | null;
  };
};

export type NormalizedEvent =
  | { type: "message.upsert"; orgId?: string; message: NormalizedMessage }
  | {
      type: "message.status";
      orgId?: string;
      providerMsgId: string;
      jid?: string;
      status: DeliveryStatus;
      detail?: string;
    }
  | {
      type: "connection.status";
      orgId?: string;
      state: ConnectionState;
      detail?: string;
      account?: { jid?: string; lid?: string; phone?: string; name?: string } | null;
    }
  | { type: "qr"; orgId?: string; qrCode: string | null }
  | { type: "error"; orgId?: string; code: string; message: string };

/** Resultado de envio vindo do adapter — `status` é canônico, nunca otimosita. */
export type AdapterSendResult = {
  ok: boolean;
  providerMsgId?: string;
  /** `pending` = saiu do nosso socket sem <ack>; `sent` = servidor aceitou. */
  status?: DeliveryStatus;
  error?: string;
  /** true/false se o adapter conseguiu confirmar que o número existe. */
  recipientExists?: boolean;
  /** JID real para o qual o provedor enviou a mensagem (ex.: normalizado para 8 dígitos BR ou @lid). */
  resolvedJid?: string;
};

export type AdapterStatus = {
  state: ConnectionState;
  detail?: string;
  phone?: string | null;
  accountName?: string | null;
  avatarUrl?: string | null;
  jid?: string | null;
  lid?: string | null;
  lastSyncAt?: Date | null;
  provider: string;
  mock: boolean;
};
