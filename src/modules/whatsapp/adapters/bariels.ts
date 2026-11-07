import { db } from "@/lib/db";
import {
  WhatsAppAdapterError,
  type AdapterContext,
  type ConnectOptions,
  type ContactRecord,
  type ConversationRecord,
  type MediaInput,
  type ProviderMessageRecord,
  type QrSnapshot,
  type SendTarget,
  type WhatsAppAdapter,
} from "../adapter";
import {
  toCanonicalDirection,
  toCanonicalStatus,
  type AdapterSendResult,
  type AdapterStatus,
  type ConnectionState,
  type NormalizedEvent,
} from "../types";
import { normalizeWebMessage } from "../baileys/normalize";
import { BARIELS_NAME } from "./names";

/**
 * BarielsAdapter (§16) — a cara do WhatsApp Web/Baileys dentro deste projeto.
 *
 * É o ÚNICO arquivo do CRM que sabe que o socket existe. Ele importa o módulo Baileys
 * dinamicamente por dois motivos: (1) o Next não pode arrastar Baileys para o bundle do
 * navegador, e (2) se amanhã o provider for Evolution/Cloud API, apenas este arquivo muda.
 *
 * Regra de honestidade herdada da investigação de 27/10: o adapter devolve o status que o
 * SERVIDOR confirmou. Sem `<ack>` = `pending`, nunca `sent`.
 */

type BaileysModule = typeof import("../baileys/provider");

let modulePromise: Promise<BaileysModule> | null = null;

/** Carrega o módulo uma vez por processo (o socket em si vive em globalThis). */
function baileys(): Promise<BaileysModule> {
  if (!modulePromise) modulePromise = import("../baileys/provider");
  return modulePromise;
}

/** Estado interno do Baileys → estado canônico da tela (§2). */
function toConnectionState(status: string, hasQr: boolean): ConnectionState {
  switch (status) {
    case "CONNECTED":
      return "CONNECTED";
    case "ERROR":
      return "ERROR";
    case "PENDING_QR":
      return hasQr ? "WAITING_QR" : "CONNECTING";
    case "RECONNECT_REQUIRED":
      return "RECONNECT_REQUIRED";
    default:
      return "DISCONNECTED";
  }
}

function adapterError(err: unknown): never {
  if (err instanceof WhatsAppAdapterError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (/não conectado/i.test(message)) {
    throw new WhatsAppAdapterError("NOT_CONNECTED", message);
  }
  if (/outra (?:barbearia|clínica|org)/i.test(message)) {
    throw new WhatsAppAdapterError("AUTH_ERROR", message);
  }
  if (/invalid|descart|discável|incompleto/i.test(message)) {
    throw new WhatsAppAdapterError("INVALID_NUMBER", message);
  }
  throw new WhatsAppAdapterError("UNKNOWN", message);
}

export class BarielsAdapter implements WhatsAppAdapter {
  readonly name = BARIELS_NAME;
  readonly mock = false;

  async getStatus(ctx: AdapterContext): Promise<AdapterStatus> {
    const m = await baileys();
    const snap = await m.baileysSnapshot(ctx.orgId);

    // Socket de outra barbearia: PARA esta org o estado é desconectado. Foi assim que uma
    // org de teste apareceu "CONNECTED" no mesmo milissegundo da org real.
    if (snap.ownerOrgId && snap.ownerOrgId !== ctx.orgId) {
      return {
        state: "DISCONNECTED",
        detail: "Existe um WhatsApp conectado em outra clínica. Desconecte-o antes.",
        provider: this.name,
        mock: false,
      };
    }

    const qrLive = Boolean(snap.qr.qrCode);
    return {
      state: toConnectionState(snap.state.status, qrLive),
      detail: snap.state.detail ?? undefined,
      phone: snap.account?.phone ?? null,
      accountName: snap.account?.name ?? null,
      jid: snap.account?.jid ?? null,
      lid: snap.account?.lid ?? null,
      provider: this.name,
      mock: false,
    };
  }

  async connect(ctx: AdapterContext, opts: ConnectOptions = {}): Promise<AdapterStatus> {
    const m = await baileys();
    try {
      // ensureQrOrConnected só retorna com QR na tela, conexão aberta ou erro explicado.
      await m.ensureQrOrConnected(ctx.orgId, { freshQr: opts.freshQr });
    } catch (err) {
      adapterError(err);
    }
    return this.getStatus(ctx);
  }

  async disconnect(ctx: AdapterContext): Promise<void> {
    const m = await baileys();
    try {
      const provider = new m.BaileysProvider();
      await provider.disconnect(ctx.orgId);
    } catch (err) {
      adapterError(err);
    }
  }

  async getQr(ctx: AdapterContext): Promise<QrSnapshot> {
    const m = await baileys();
    const snap = await m.baileysSnapshot(ctx.orgId);
    if (snap.ownerOrgId && snap.ownerOrgId !== ctx.orgId) {
      return { qrCode: null, state: "DISCONNECTED", detail: "Socket pertence a outra clínica." };
    }
    return {
      qrCode: snap.qr.qrCode,
      state: toConnectionState(snap.state.status, Boolean(snap.qr.qrCode)),
      detail: snap.qr.detail ?? snap.state.detail ?? null,
      ageMs: snap.qr.ageMs ?? null,
      createdAt: snap.qr.createdAt ?? null,
      justPaired: snap.qr.justPaired ?? false,
      lastStatusCode: snap.qr.lastStatusCode ?? null,
      reconnectAttempts: snap.qr.reconnectAttempts ?? null,
    };
  }

  /**
   * Sobe a sessão salva antes de enviar e recusa com erro amigo quando não há conexão.
   * Fazer isso aqui (e não em cada rota) é o que garante que job agendado, chat da tela e
   * reenvio depois de restart sigam exatamente o mesmo caminho.
   */
  private async ensureReady(ctx: AdapterContext): Promise<void> {
    const m = await baileys();
    const status = await m.ensureConnected(ctx.orgId, 20_000);
    if (status.status !== "CONNECTED") {
      throw new WhatsAppAdapterError(
        "NOT_CONNECTED",
        status.detail ?? "Baileys não conectado",
        status.status === "DISCONNECTED" && /outra (?:barbearia|clínica)/.test(status.detail ?? "")
          ? (status.detail as string)
          : "Não foi possível enviar. O WhatsApp está desconectado — escaneie o QR Code em Configurações → WhatsApp."
      );
    }
  }

  async sendText(ctx: AdapterContext, target: SendTarget, text: string): Promise<AdapterSendResult> {
    const m = await baileys();
    await this.ensureReady(ctx);
    const result = await m.baileysSendText(ctx.orgId, { phone: target.phone, jid: target.jid }, text);
    return {
      ok: result.ok,
      providerMsgId: result.providerMsgId,
      status: result.status ? toCanonicalStatus(result.status) as AdapterSendResult["status"] : undefined,
      error: result.error,
      recipientExists: result.recipientExists,
      resolvedJid: result.resolvedJid,
    };
  }

  async sendMedia(ctx: AdapterContext, target: SendTarget, media: MediaInput): Promise<AdapterSendResult> {
    const m = await baileys();
    await this.ensureReady(ctx);
    const result = await m.baileysSendMedia(
      ctx.orgId,
      { phone: target.phone, jid: target.jid },
      media.url,
      media.caption,
      media.kind,
      media.fileName,
      media.mimeType
    );
    return {
      ok: result.ok,
      providerMsgId: result.providerMsgId,
      status: result.status ? toCanonicalStatus(result.status) as AdapterSendResult["status"] : undefined,
      error: result.error,
      recipientExists: result.recipientExists,
      resolvedJid: result.resolvedJid,
    };
  }

  /**
   * No WhatsApp Web não existe "listar todas as conversas do aparelho" sem history-sync,
   * e nós não pedimos histórico completo de propósito: é dado pessoal dos clientes.
   * A fonte de verdade do que já conversamos é o nosso banco (§12/§13).
   */
  /**
   * Existe pareamento salvo nesta pasta de sessão? É a pergunta que decide se vale a pena o
   * worker reconectar sem QR. Org de teste sem pasta nenhuma responde false — e é assim que
   * ela para de "roubar" o socket de quem tem QR escaneado.
   */
  async hasStoredSession(ctx: AdapterContext): Promise<boolean> {
    const m = await baileys();
    return m.hasSavedSession(ctx.orgId);
  }

  async getContacts(ctx: AdapterContext, limit = 200): Promise<ContactRecord[]> {
    const rows = await db.whatsAppContact.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { lastSeenAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      jid: r.jid,
      phone: r.phone,
      name: r.name,
      masked: r.masked,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  async getConversations(ctx: AdapterContext, limit = 100): Promise<ConversationRecord[]> {
    const rows = await db.whatsAppConversation.findMany({
      where: { orgId: ctx.orgId, archived: false },
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
    const contact = await db.whatsAppContact.findUnique({
      where: { orgId_jid: { orgId: ctx.orgId, jid } },
    });
    if (!contact) return [];

    const rows = await db.whatsAppMessage.findMany({
      where: { orgId: ctx.orgId, contactId: contact.id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      providerMsgId: r.providerMsgId ?? r.id,
      jid,
      direction: toCanonicalDirection(r.direction),
      text: r.body,
      messageType: r.messageType,
      createdAt: r.createdAt,
      status: r.status,
    }));
  }

  /**
   * Converte payload cru em evento normalizado (§11).
   * Aceita três formas: mensagem do WhatsApp Web (proto), recibo `{key, update}` e o
   * formato canônico de webhook `{event, phone, message_id, text, timestamp}` descrito no
   * prompt. Quem conhece o formato do fornecedor é só este método.
   */
  normalizeRaw(raw: unknown): NormalizedEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const node = raw as Record<string, any>;

    // 1) WAMessageInfo do socket
    if (node.key?.remoteJid) {
      const message = normalizeWebMessage(node as any);
      if (!message) return null;
      return { type: "message.upsert", message };
    }

    // 2) recibo de status
    if (node.key?.id && node.update?.status != null) {
      return {
        type: "message.status",
        providerMsgId: String(node.key.id),
        jid: node.key.remoteJid ? String(node.key.remoteJid) : undefined,
        status: toCanonicalStatus(String(node.update.status)) as any,
      };
    }

    // 3) webhook genérico já próximo do nosso vocabulário
    const phone = node.phone ?? node.to ?? node.remoteJid;
    const text = node.text ?? node.body ?? node.message ?? "";
    const id = node.message_id ?? node.messageId ?? node.id;
    if (phone && id) {
      const jid = String(phone).includes("@") ? String(phone) : `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;
      return {
        type: "message.upsert",
        message: {
          jid,
          phone: jid.endsWith("@lid") ? null : String(phone).replace(/\D/g, "") || null,
          masked: jid.endsWith("@lid"),
          direction: node.from === "crm" || node.direction === "out" ? "outgoing" : "incoming",
          messageType: node.messageType ?? "text",
          text: String(text),
          providerMsgId: String(id),
          timestampSec: node.timestamp ? Number(node.timestamp) : undefined,
          pushName: node.pushName ?? node.contact_name ?? null,
        },
      };
    }

    return null;
  }
}
