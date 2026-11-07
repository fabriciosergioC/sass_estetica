// Camada de abstração de provedor WhatsApp.
// O sistema nunca fala diretamente com a API de um vendor: só com esta interface.
// Trocar de provedor = implementar WhatsAppProvider e registrar em PROVIDERS.

export type SendResult = {
  ok: boolean;
  providerMsgId?: string;
  error?: string;
  /** ACK que o provedor devolveu na hora do envio (ex.: "SERVER_ACK", "DELIVERY_ACK"). */
  ack?: string;
  /** Status de entrega equivalente ao ACK: QUEUED | SENT | DELIVERED | READ | FAILED. */
  status?: string;
  /** true/false quando foi possível confirmar no servidor do WhatsApp se o número tem conta. */
  recipientExists?: boolean;
  /** JID final resolvido para o qual a mensagem foi enviada. */
  resolvedJid?: string;
};

export type ProviderStatus = {
  status: "CONNECTED" | "DISCONNECTED" | "PENDING_QR" | "ERROR";
  detail?: string;
};

export interface WhatsAppProvider {
  readonly name: string;
  sendMessage(phone: string, body: string): Promise<SendResult>;
  sendTemplate(phone: string, templateKey: string, body: string): Promise<SendResult>;
  sendMedia(phone: string, mediaUrl: string, caption?: string): Promise<SendResult>;
  checkConnection(): Promise<ProviderStatus>;
  getStatus(): Promise<ProviderStatus>;
  /** Processa webhook recebido do provedor; retorna payload normalizado ou null se inválido. */
  processWebhook(raw: unknown): { externalId: string; status: string } | null;

  // Métodos específicos para Baileys
  connect?(orgId: string): Promise<void>;
  disconnect?(): Promise<void>;
}

/** Provedor de desenvolvimento: simula envio e é sempre "conectado". */
class DevProvider implements WhatsAppProvider {
  readonly name = "DEV";

  private ok(): SendResult {
    return { ok: true, providerMsgId: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }

  async sendMessage(_phone: string, _body: string): Promise<SendResult> {
    return this.ok();
  }
  async sendTemplate(_phone: string, _templateKey: string, _body: string): Promise<SendResult> {
    return this.ok();
  }
  async sendMedia(_phone: string, _mediaUrl: string, _caption?: string): Promise<SendResult> {
    return this.ok();
  }
  async checkConnection(): Promise<ProviderStatus> {
    return { status: "CONNECTED", detail: "Provedor de desenvolvimento (simulado)." };
  }
  async getStatus(): Promise<ProviderStatus> {
    return this.checkConnection();
  }
  processWebhook(raw: unknown): { externalId: string; status: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (!r.key || typeof r.key !== "object" || !("id" in r.key)) return null;
    const key = r.key as { id: string };
    return { externalId: String(key.id), status: String(r.status ?? "SENT") };
  }
}

/** Provedor real não configurado: falha explícita em vez de fingir envio. */
class UnconfiguredProvider implements WhatsAppProvider {
  constructor(readonly name: string) {}
  private fail(): SendResult {
    return { ok: false, error: `Provedor "${this.name}" não configurado. Verifique as variáveis de ambiente.` };
  }
  async sendMessage(): Promise<SendResult> {
    return this.fail();
  }
  async sendTemplate(): Promise<SendResult> {
    return this.fail();
  }
  async sendMedia(): Promise<SendResult> {
    return this.fail();
  }
  async checkConnection(): Promise<ProviderStatus> {
    return { status: "ERROR", detail: `Provedor "${this.name}" não configurado.` };
  }
  async getStatus(): Promise<ProviderStatus> {
    return this.checkConnection();
  }
  processWebhook(): null {
    return null;
  }
}

// Importar Baileys dinamicamente para evitar erros de build
let BaileysProvider: any = null;
let baileysInit: any = null;

async function getBaileysProvider() {
  if (!BaileysProvider) {
    const module = await import("./baileys/provider");
    BaileysProvider = module.BaileysProvider;
    baileysInit = module.initBaileys;
  }
  return { BaileysProvider, baileysInit };
}

export function getWhatsAppProvider(name?: string): WhatsAppProvider {
  const provider = (name ?? process.env.WHATSAPP_PROVIDER ?? "dev").toLowerCase();

  switch (provider) {
    case "dev":
      return new DevProvider();
    case "baileys":
      // Retorna proxy que inicializa Baileys sob demanda
      return new BaileysProxyProvider();
    case "evolution":
      return new UnconfiguredProvider("evolution");
    case "meta_cloud":
      return new UnconfiguredProvider("meta_cloud");
    case "zapi":
      return new UnconfiguredProvider("zapi");
    default:
      return new DevProvider();
  }
}

// Proxy para inicialização lazy do Baileys
class BaileysProxyProvider implements WhatsAppProvider {
  readonly name = "baileys";
  private realProvider: WhatsAppProvider | null = null;

  private async ensureProvider(orgId?: string): Promise<WhatsAppProvider> {
    if (!this.realProvider) {
      const { BaileysProvider, baileysInit } = await getBaileysProvider();
      this.realProvider = new BaileysProvider();
      // Inicializar conexão se orgId fornecido
      if (orgId && baileysInit) {
        await baileysInit(orgId);
      }
    }
    return this.realProvider!;
  }

  async sendMessage(phone: string, body: string): Promise<SendResult> {
    const provider = await this.ensureProvider();
    return provider.sendMessage(phone, body);
  }

  async sendTemplate(phone: string, templateKey: string, body: string): Promise<SendResult> {
    const provider = await this.ensureProvider();
    return provider.sendTemplate(phone, templateKey, body);
  }

  async sendMedia(phone: string, mediaUrl: string, caption?: string): Promise<SendResult> {
    const provider = await this.ensureProvider();
    return provider.sendMedia(phone, mediaUrl, caption);
  }

  async checkConnection(): Promise<ProviderStatus> {
    const provider = await this.ensureProvider();
    return provider.checkConnection();
  }

  async getStatus(): Promise<ProviderStatus> {
    const provider = await this.ensureProvider();
    return provider.getStatus();
  }

  processWebhook(raw: unknown): { externalId: string; status: string } | null {
    return null; // Baileys não usa webhook externo
  }
}

export async function initBaileysConnection(orgId: string): Promise<void> {
  const { baileysInit } = await getBaileysProvider();
  if (baileysInit) {
    await baileysInit(orgId);
  }
}

/**
 * Garante a sessão Baileys antes de um envio automático e devolve o estado real.
 * É o que faltava no caminho de jobs: sem chamar isto, qualquer lembrete depois de
 * reiniciar o Next morria em "Baileys não conectado: Não iniciado".
 */
export async function ensureBaileysConnected(orgId: string, timeoutMs = 20_000) {
  const module = await import("./baileys/provider");
  return module.ensureConnected(orgId, timeoutMs);
}

/** Derruba o socket, apaga a sessão salva e sobe um novo: sempre resulta em QR novo. */
export async function restartBaileysWithFreshQr(orgId: string, source?: string): Promise<void> {
  const module = await import("./baileys/provider");
  await module.restartWithFreshQr(orgId, source);
}

/** Aguarda o primeiro QR Code aparecer (ou a conexão abrir), no máximo `ms`. */
export async function waitForBaileysQr(ms: number): Promise<void> {
  const module = await import("./baileys/provider");
  await module.waitForQr(ms);
}

/** Fotografia do QR atual (imagem base64 + idade + detalhe do estado). */
export async function getBaileysQrSnapshot() {
  const module = await import("./baileys/provider");
  return module.getQrSnapshot();
}

/** Conecta e garante que termine em conectado, QR pronto, ou erro explicado. */
export async function ensureBaileysQr(orgId: string, opts: { freshQr?: boolean } = {}): Promise<void> {
  const module = await import("./baileys/provider");
  await module.ensureQrOrConnected(orgId, opts);
}

export async function disconnectBaileys(orgId?: string): Promise<void> {
  const { BaileysProvider } = await getBaileysProvider();
  const provider = new BaileysProvider();
  await provider.disconnect(orgId);
}