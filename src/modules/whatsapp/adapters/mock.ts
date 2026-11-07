import QRCode from "qrcode";
import {
  type AdapterContext,
  type ContactRecord,
  type ConversationRecord,
  type MediaInput,
  type ProviderMessageRecord,
  type QrSnapshot,
  type SendTarget,
  type WhatsAppAdapter,
} from "../adapter";
import type { AdapterSendResult, AdapterStatus, ConnectionState, NormalizedEvent, NormalizedMessage } from "../types";
import { MOCK_NAME } from "./names";

/**
 * Modo mock (§32): `WHATSAPP_MOCK=true`.
 *
 * Promessa deste arquivo: NENHUMA chamada de rede para o WhatsApp. Nada de Baileys, nada de
 * API externa. Ele existe para desenvolver e testar a interface, a fila e o histórico sem
 * número real — e para que um ambiente sem credencial consiga demonstrar o fluxo inteiro.
 *
 * A máquina de estados é avaliada por tempo decorrido (sem `setInterval`): em dev o Next
 * recarrega módulos a toda hora e timer solto viraria evento duplicado/concorrente.
 */

const QR_REFRESH_MS = 45_000;
const CONNECT_AFTER_MS = 12_000;

type MockState = {
  startedAt: number | null;
  connectedAt: number | null;
  qrIssuedAt: number | null;
  qrCode: string | null;
  /** Evita publicar o mesmo evento de conexão mais de uma vez. */
  announced: boolean;
};

type MockStore = {
  orgs: Map<string, MockState>;
  handlers: Map<string, (event: NormalizedEvent) => void>;
};

const GLOBAL_KEY = "__whatsapp_mock__" as const;

function store(): MockStore {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { orgs: new Map(), handlers: new Map() };
  const s: MockStore = g[GLOBAL_KEY];
  s.orgs ??= new Map();
  s.handlers ??= new Map();
  return s;
}

function fresh(): MockState {
  return { startedAt: null, connectedAt: null, qrIssuedAt: null, qrCode: null, announced: false };
}

function stateOf(orgId: string): MockState {
  let s = store().orgs.get(orgId);
  if (!s) {
    s = fresh();
    store().orgs.set(orgId, s);
  }
  return s;
}

function emit(ctx: AdapterContext, event: NormalizedEvent) {
  store().handlers.get(ctx.orgId)?.({ ...event, orgId: ctx.orgId } as NormalizedEvent);
}

/** QR em PNG base64 de verdade (mesmo formato que o Baileys entrega), só que sem valor. */
async function renderQr(payload: string): Promise<string | null> {
  try {
    const dataUrl = await QRCode.toDataURL(payload, { type: "image/png", margin: 1, width: 300 });
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  } catch {
    return null;
  }
}

export class MockAdapter implements WhatsAppAdapter {
  readonly name = MOCK_NAME;
  readonly mock = true;

  /**
   * Avança a máquina de estados conforme o relógio e notifica as transições.
   * Chamado por todo método público: quem consulta o estado é quem o atualiza.
   */
  private async tick(ctx: AdapterContext): Promise<MockState> {
    const s = stateOf(ctx.orgId);
    const now = Date.now();

    if (s.startedAt == null) return s;

    if (s.connectedAt == null && now - s.startedAt >= CONNECT_AFTER_MS) {
      s.connectedAt = now;
      s.qrCode = null;
      s.qrIssuedAt = null;
      if (!s.announced) {
        s.announced = true;
        emit(ctx, {
          type: "connection.status",
          state: "CONNECTED",
          detail: "Conectado (modo mock).",
          account: {
            jid: "5500000000000@s.whatsapp.net",
            phone: "5500000000000",
            name: "Clínica (mock)",
          },
        });
      }
      return s;
    }

    if (s.connectedAt == null && (!s.qrCode || now - (s.qrIssuedAt ?? 0) > QR_REFRESH_MS)) {
      s.qrIssuedAt = now;
      s.qrCode = await renderQr(`whatsapp-mock:${ctx.orgId}:${now}`);
      emit(ctx, { type: "qr", qrCode: s.qrCode });
    }

    return s;
  }

  private currentState(s: MockState): ConnectionState {
    if (s.connectedAt) return "CONNECTED";
    if (s.startedAt == null) return "DISCONNECTED";
    return s.qrCode ? "WAITING_QR" : "CONNECTING";
  }

  async getStatus(ctx: AdapterContext): Promise<AdapterStatus> {
    const s = await this.tick(ctx);
    return {
      state: this.currentState(s),
      detail: s.connectedAt ? "Conectado (modo mock)." : s.startedAt ? "Aguardando leitura do QR (simulado)." : "Não iniciado.",
      phone: s.connectedAt ? "5500000000000" : null,
      accountName: s.connectedAt ? "Clínica (mock)" : null,
      jid: s.connectedAt ? "5500000000000@s.whatsapp.net" : null,
      provider: this.name,
      mock: true,
    };
  }

  async connect(ctx: AdapterContext, opts: { freshQr?: boolean } = {}): Promise<AdapterStatus> {
    const s = stateOf(ctx.orgId);
    if (opts.freshQr || s.startedAt == null) {
      s.startedAt = Date.now();
      s.connectedAt = null;
      s.announced = false;
      s.qrCode = null;
      s.qrIssuedAt = null;
    }
    await this.tick(ctx);
    return this.getStatus(ctx);
  }

  async disconnect(ctx: AdapterContext): Promise<void> {
    store().orgs.set(ctx.orgId, fresh());
    emit(ctx, { type: "connection.status", state: "DISCONNECTED", detail: "Desconectado (modo mock)." });
  }

  async getQr(ctx: AdapterContext): Promise<QrSnapshot> {
    const s = await this.tick(ctx);
    return {
      qrCode: s.qrCode,
      state: this.currentState(s),
      detail: s.qrCode ? "QR simulado — não conecta no WhatsApp de verdade." : null,
      ageMs: s.qrIssuedAt ? Date.now() - s.qrIssuedAt : null,
    };
  }

  /** Simula a resposta do WhatsApp: aceita e confirma entrega em passos. */
  async sendText(ctx: AdapterContext, target: SendTarget, text: string): Promise<AdapterSendResult> {
    const status = await this.getStatus(ctx);
    if (status.state !== "CONNECTED") {
      return { ok: false, status: "failed", error: "O WhatsApp está desconectado (modo mock)." };
    }
    const digits = target.jid ? target.jid.split("@")[0] : (target.phone ?? "").replace(/\D/g, "");
    if (!digits || digits.length < 10) {
      return { ok: false, status: "failed", error: "Número inválido: use DDI + DDD, ex.: 5531987707962." };
    }

    const id = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // Delivery/read chegam depois, como no real: é isso que exercita a ladder de status.
    setTimeout(() => {
      emit(ctx, { type: "message.status", providerMsgId: id, status: "delivered", jid: target.jid ?? undefined });
    }, 1_500);
    return { ok: true, providerMsgId: id, status: "sent", recipientExists: true };
  }

  async sendMedia(ctx: AdapterContext, target: SendTarget, media: MediaInput): Promise<AdapterSendResult> {
    const result = await this.sendText(ctx, target, media.caption ?? `[${media.kind}]`);
    return result;
  }

  /**
   * Mensagem de entrada simulada — só existe quando alguém pede explicitamente
   * (testes, ou `WHATSAPP_MOCK_INBOUND=1` na conexão). Gerar conversa sozinho em mock
   * enchia o banco de lixo, que é exatamente o que pediram para limpar.
   */
  async simulateIncoming(
    ctx: AdapterContext,
    input: { phone: string; text: string; name?: string }
  ): Promise<NormalizedMessage> {
    const digits = input.phone.replace(/\D/g, "");
    const message: NormalizedMessage = {
      jid: `${digits}@s.whatsapp.net`,
      phone: digits,
      masked: false,
      direction: "incoming",
      messageType: "text",
      text: input.text,
      providerMsgId: `mock_in_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestampSec: Math.floor(Date.now() / 1000),
      pushName: input.name ?? `Contato ${digits.slice(-4)}`,
    };
    emit(ctx, { type: "message.upsert", message });
    return message;
  }

  async getContacts(ctx: AdapterContext, limit = 200): Promise<ContactRecord[]> {
    const { db } = await import("@/lib/db");
    const rows = await db.whatsAppContact.findMany({ where: { orgId: ctx.orgId }, take: limit });
    return rows.map((r) => ({
      jid: r.jid,
      phone: r.phone,
      name: r.name,
      masked: r.masked,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  async getConversations(ctx: AdapterContext, limit = 100): Promise<ConversationRecord[]> {
    const { db } = await import("@/lib/db");
    const rows = await db.whatsAppConversation.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
      include: { contact: true },
    });
    return rows.map((r) => ({
      jid: r.contact.jid,
      name: r.contact.name,
      lastBody: r.lastBody,
      lastMessageAt: r.lastMessageAt,
      unreadCount: r.unreadCount,
    }));
  }

  async getMessages(ctx: AdapterContext, jid: string, limit = 50): Promise<ProviderMessageRecord[]> {
    const { db } = await import("@/lib/db");
    const contact = await db.whatsAppContact.findUnique({ where: { orgId_jid: { orgId: ctx.orgId, jid } } });
    if (!contact) return [];
    const rows = await db.whatsAppMessage.findMany({
      where: { orgId: ctx.orgId, contactId: contact.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      providerMsgId: r.providerMsgId ?? r.id,
      jid,
      direction: r.direction === "IN" ? "incoming" : "outgoing",
      text: r.body,
      messageType: r.messageType,
      createdAt: r.createdAt,
      status: r.status,
    }));
  }

  normalizeRaw(raw: unknown): NormalizedEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const node = raw as Record<string, any>;
    if (!node.phone || !node.text) return null;
    const digits = String(node.phone).replace(/\D/g, "");
    return {
      type: "message.upsert",
      message: {
        jid: `${digits}@s.whatsapp.net`,
        phone: digits,
        masked: false,
        direction: node.direction === "out" ? "outgoing" : "incoming",
        messageType: "text",
        text: String(node.text),
        providerMsgId: String(node.message_id ?? node.id ?? `mock_${Date.now()}`),
        timestampSec: node.timestamp ? Number(node.timestamp) : Math.floor(Date.now() / 1000),
        pushName: node.name ?? null,
      },
    };
  }

  /** No mock, "sessão salva" é ter conectado antes neste mesmo processo. */
  async hasStoredSession(ctx: AdapterContext): Promise<boolean> {
    return stateOf(ctx.orgId).connectedAt != null;
  }

  /** O serviço usa este gancho para receber os eventos simulados e persisti-los. */
  attachEventHandler(ctx: AdapterContext, handler: (event: NormalizedEvent) => void): void {
    store().handlers.set(ctx.orgId, handler);
  }

  detachEventHandler(ctx: AdapterContext): void {
    store().handlers.delete(ctx.orgId);
  }
}

/** Limpa o estado do mock (usado em testes). */
export function resetMock(orgId?: string): void {
  if (orgId) store().orgs.delete(orgId);
  else store().orgs.clear();
}
