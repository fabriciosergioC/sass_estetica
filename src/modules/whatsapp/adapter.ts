import type { AdapterSendResult, AdapterStatus, NormalizedEvent } from "./types";

/**
 * Contrato único entre o CRM e qualquer API de WhatsApp (§1 e §16 do prompt).
 *
 * Regra da casa: nenhuma rota, página ou módulo de negócio importa Baileys. Quem importa é o
 * `BarielsAdapter`. Trocar de provider = escrever outro adapter e registrar em
 * `adapters/index.ts`, sem tocar em service/UI/API.
 */

export type AdapterContext = {
  orgId: string;
  /** Linha WhatsAppConnection da org (criada pelo service quando não existe). */
  connectionId: string;
};

export type ConnectOptions = {
  /** Descarta a sessão salva e emite um QR novo com certeza. */
  freshQr?: boolean;
  /** Quantos ms esperar por QR/abertura antes de devolver o estado atual. */
  timeoutMs?: number;
};

export type QrSnapshot = {
  /** PNG em base64 (sem prefixo data:), ou null quando não há QR pendente. */
  qrCode: string | null;
  state: AdapterStatus["state"];
  detail?: string | null;
  /** Idade do QR em ms — QR velho já não funciona, a UI usa para avisar. */
  ageMs?: number | null;
  /** Epoch ms de geração; a tela compara com o último quadro para saber se é o MESMO QR. */
  createdAt?: number | null;
  /** true entre escanear o QR e o login concluir (o WhatsApp manda reiniciar o socket). */
  justPaired?: boolean;
  /** Último código de desconexão do WhatsApp — é o que explica o "aparelho removido". */
  lastStatusCode?: number | null;
  reconnectAttempts?: number | null;
};

export type SendTarget = {
  /** Número digitado/usado no CRM; o adapter resolve para jid e confere no servidor. */
  phone?: string | null;
  /** jid conhecido (contato já mapeado, ex.: @lid). Tem precedência sobre `phone`. */
  jid?: string | null;
};

export type MediaInput = {
  kind: "image" | "video" | "audio" | "document";
  /** data URL ou URL http(s) — o adapter baixa/converte como o provider exigir. */
  url: string;
  caption?: string;
  fileName?: string;
  mimeType?: string;
};

export type ContactRecord = {
  jid: string;
  phone: string | null;
  name: string | null;
  masked: boolean;
  lastSeenAt: Date | null;
};

export type ConversationRecord = {
  jid: string;
  name: string | null;
  lastBody: string | null;
  lastMessageAt: Date;
  unreadCount: number;
};

export type ProviderMessageRecord = {
  providerMsgId: string;
  jid: string;
  direction: "incoming" | "outgoing";
  text: string;
  messageType: string;
  createdAt: Date;
  status: string | null;
};

export interface WhatsAppAdapter {
  /** Identificador estável usado em logs, config e WhatsAppConnection.provider. */
  readonly name: string;
  /** true quando não fala com o WhatsApp de verdade (WHATSAPP_MOCK=true). */
  readonly mock: boolean;

  getStatus(ctx: AdapterContext): Promise<AdapterStatus>;
  connect(ctx: AdapterContext, opts?: ConnectOptions): Promise<AdapterStatus>;
  disconnect(ctx: AdapterContext): Promise<void>;
  getQr(ctx: AdapterContext): Promise<QrSnapshot>;

  sendText(ctx: AdapterContext, target: SendTarget, text: string): Promise<AdapterSendResult>;
  sendMedia(ctx: AdapterContext, target: SendTarget, media: MediaInput): Promise<AdapterSendResult>;

  /**
   * Contatos/conversas/mensagens que a fonte de verdade do provider conhece.
   * No Bariels (WhatsApp Web) o histórico completo do aparelho não é exposto sem
   * history-sync, então a fonte real é o que o próprio adapter já recebeu e o CRM gravou.
   */
  getContacts(ctx: AdapterContext, limit?: number): Promise<ContactRecord[]>;
  getConversations(ctx: AdapterContext, limit?: number): Promise<ConversationRecord[]>;
  getMessages(ctx: AdapterContext, jid: string, limit?: number): Promise<ProviderMessageRecord[]>;

  /**
   * Converte o payload cru do provider (ou de um webhook HTTP) em eventos normalizados.
   * §11: não assumimos os nomes do provider — quem conhece o formato é o adapter.
   */
  normalizeRaw(raw: unknown): NormalizedEvent | null;

  /** true quando este provider tem uma sessão salva capaz de reconectar sem QR (§18). */
  hasStoredSession?(ctx: AdapterContext): Promise<boolean>;

  /** Registra o callback que recebe eventos em tempo real do provider. */
  attachEventHandler?(ctx: AdapterContext, handler: (event: NormalizedEvent) => void): void;
  detachEventHandler?(ctx: AdapterContext): void;
}

/** Erro de adapter com código estável, para a UI mostrar mensagem amiga (§17). */
export class WhatsAppAdapterError extends Error {
  constructor(
    readonly code:
      | "API_OFFLINE"
      | "SESSION_EXPIRED"
      | "NOT_CONNECTED"
      | "INVALID_NUMBER"
      | "TIMEOUT"
      | "RATE_LIMIT"
      | "MEDIA_ERROR"
      | "AUTH_ERROR"
      | "WEBHOOK_INVALID"
      | "UNKNOWN",
    message: string,
    readonly friendly?: string
  ) {
    super(message);
    this.name = "WhatsAppAdapterError";
  }
}

export const FRIENDLY_ERROR: Record<WhatsAppAdapterError["code"], string> = {
  API_OFFLINE: "A API do WhatsApp está inacessível. Verifique a conexão e tente de novo.",
  SESSION_EXPIRED: "A sessão do WhatsApp expirou. Conecte de novo escaneando o QR Code.",
  NOT_CONNECTED: "Não foi possível enviar a mensagem. O WhatsApp está desconectado.",
  INVALID_NUMBER: "Esse número não é discável no WhatsApp. Confira DDI e DDD.",
  TIMEOUT: "O WhatsApp demorou para responder e o envio ficou na fila. Tente novamente.",
  RATE_LIMIT: "O WhatsApp limitou o ritmo de envio. Aguarde antes de mandar de novo.",
  MEDIA_ERROR: "Não foi possível enviar o anexo. O arquivo pode ser grande ou estar inacessível.",
  AUTH_ERROR: "Credencial inválida para o provedor configurado.",
  WEBHOOK_INVALID: "Evento recebido fora do formato esperado e foi descartado.",
  UNKNOWN: "Falha inesperada no WhatsApp. O erro ficou registrado em WhatsApp → Logs.",
};
