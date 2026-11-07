// Provedor Baileys - Conexão direta com WhatsApp Web
// Implementação nativa sem depender de API externa
//
// IMPORTANTE 1: O Next.js recarrega módulos no dev mode (hot reload).
// Usamos globalThis para manter o estado do socket entre reloads.
//
// IMPORTANTE 2: o WhatsApp só envia um QR Code para uma sessão NOVA (sem credenciais
// válidas). Se a pasta de auth existir mas a sessão foi revogada no celular, o Baileys
// tenta reconectar com as credenciais antigas, recebe "401 loggedOut" e nunca gera QR.
// Por isso todo close com erro de autenticação apaga a pasta de auth antes de reiniciar.
// Também garantimos um único socket por vez: dois sockets dividindo a mesma pasta de
// auth se expulsam ("440 connectionReplaced") e corrompem as credenciais.

import {
  WASocket,
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  delay,
  jidNormalizedUser,
  extractMessageContent
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { toWhatsAppDigits } from "@/lib/phone";
import type { WhatsAppProvider, SendResult, ProviderStatus } from "../provider";
import { ingestConnection, ingestEvent, ingestQr } from "../ingest";
import { toDbStatus, type ConnectionState } from "../types";
import { normalizeAck, normalizeWebMessage, statusFromAck } from "./normalize";

// ─── Constantes de ciclo de vida ───────────────────────────────────────────

/** Socket + lista dos listeners que NÓS registramos (para conseguir removê-los). */
type TrackedSocket = WASocket & { __baileysListeners: [string, (...a: any[]) => void][] };

/** Primeiro QR do Baileys vive ~60s e os seguintes ~20s. 75s cobre um ciclo completo. */
const QR_WATCHDOG_MS = 75_000;
const RECONNECT_BASE_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 5;
/** Tempo máximo esperando o WhatsApp confirmar o logout antes de seguir com a limpeza. */
const LOGOUT_TIMEOUT_MS = 4_000;

/** connectionLost e timedOut têm o mesmo código (408) no Baileys 6.7. */
const REASON_LABELS: Record<number, string> = {
  [DisconnectReason.badSession]: "Sessão inválida (badSession)",
  [DisconnectReason.connectionClosed]: "Conexão encerrada",
  [DisconnectReason.connectionLost]: "Conexão perdida ou QR expirado sem escanear",
  [DisconnectReason.connectionReplaced]: "Outro aparelho assumiu a sessão",
  [DisconnectReason.loggedOut]: "Aparelho removido do WhatsApp do celular",
  [DisconnectReason.multideviceMismatch]: "Incompatibilidade multi-device",
  [DisconnectReason.restartRequired]: "Reinício exigido pelo WhatsApp",
  [DisconnectReason.forbidden]: "Acesso negado pelo WhatsApp",
};

/**
 * Códigos que significam "essas credenciais nunca mais vão funcionar".
 * IMPORTANTE: restartRequired (515) NÃO está aqui — é o passo normal logo depois de
 * escanear o QR (o WhatsApp manda reiniciar o socket e ele deve voltar COM a credencial
 * recém-pareada). Tratar 515 como credencial morta apaga o pareamento e gera um QR novo
 * para sempre, sem nunca concluir a conexão.
 */
const AUTH_INVALID_CODES: number[] = [
  DisconnectReason.badSession,
  DisconnectReason.loggedOut,
];

/** Códigos que não adianta insistir: o problema é a conta/aparelho, não a sessão. */
const TERMINAL_CODES: number[] = [
  DisconnectReason.forbidden,
  DisconnectReason.multideviceMismatch,
];

// ─── Estado global persistente entre hot-reloads ───────────────────────────

type BaileysGlobalState = {
  /** Socket considerado "dono" do estado. Eventos de sockets antigos são descartados. */
  sock: TrackedSocket | null;
  /** Contador que identifica cada socket criado; usado para ignorar eventos obsoletos. */
  generation: number;
  connectionState: ProviderStatus;
  qrCodeRaw: string | null;
  qrCodeBase64: string | null;
  qrCreatedAt: number | null;
  /** true enquanto um `initBaileys` ainda está sendo executado (anti duplicidade). */
  isConnecting: boolean;
  /** Promise do init em andamento; chamadas concorrentes aguardam a mesma. */
  starting: Promise<void> | null;
  /** Contador de inicializações, para saber qual `starting` ainda é o atual. */
  startSeq: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  qrWatchdog: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  orgId: string | null;
  lastStatusCode: number | null;
  /** true entre o pareamento (QR escaneado) e o close seguinte: obliga manter a credencial. */
  pairedRecently: boolean;
  /**
   * Conta pareada (lida de `auth.creds.me` quando o socket abre). É o que a tela de
   * Configurações → WhatsApp mostra como "número conectado / nome" (§2) e o que o ingest
   * grava em WhatsAppAccount.
   */
  account: { jid: string | null; lid: string | null; phone: string | null; name: string | null } | null;
};

const GLOBAL_KEY = "__baileys_state__" as const;

function newGlobalState(): BaileysGlobalState {
  return {
    sock: null,
    generation: 0,
    connectionState: { status: "DISCONNECTED", detail: "Não iniciado" },
    qrCodeRaw: null,
    qrCodeBase64: null,
    qrCreatedAt: null,
    isConnecting: false,
    starting: null,
    startSeq: 0,
    reconnectTimer: null,
    qrWatchdog: null,
    reconnectAttempts: 0,
    orgId: null,
    lastStatusCode: null,
    pairedRecently: false,
    account: null,
  };
}

function getGlobal(): BaileysGlobalState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = newGlobalState();
  }
  const state: BaileysGlobalState = g[GLOBAL_KEY];
  // Compatibilidade com estados gravados por versões anteriores do módulo.
  state.generation ??= 0;
  state.qrCreatedAt ??= null;
  state.starting ??= null;
  state.startSeq ||= 0;
  state.reconnectTimer ??= null;
  state.qrWatchdog ??= null;
  state.reconnectAttempts ??= 0;
  state.lastStatusCode ??= null;
  state.pairedRecently ??= false;
  state.account ??= null;
  return state;
}

// ─── Pasta de credenciais ──────────────────────────────────────────────────

function authDirFor(orgId: string) {
  return join(process.cwd(), `baileys_auth_${orgId}`);
}

/**
 * Existe uma sessão PAREADA (creds.json com `me.id`)? Só nesse caso vale a pena tentar
 * retomar sem QR. Uma pasta de auth recém-criada tem creds sem `me` e gera QR do mesmo jeito.
 */
function hasPairedSession(orgId: string) {
  try {
    const credsPath = join(authDirFor(orgId), "creds.json");
    if (!existsSync(credsPath)) return false;
    const raw = readFileSync(credsPath, "utf-8");
    const creds = JSON.parse(raw) as { me?: { id?: string } };
    return Boolean(creds?.me?.id);
  } catch {
    return false;
  }
}

function hasSavedSession(orgId: string) {
  return hasPairedSession(orgId);
}

/**
 * Remove a pasta de credenciais. Depois disso a próxima conexão nasce sem sessão
 * e o WhatsApp é obrigado a enviar um QR Code novo.
 */
async function clearAuthDir(orgId: string) {
  const dir = authDirFor(orgId);
  try {
    await rm(dir, { recursive: true, force: true });
    console.log(`[Baileys] 🧹 Credenciais removidas: ${dir}`);
    return true;
  } catch (err) {
    console.error("[Baileys] Erro ao limpar pasta de auth:", err);
    return false;
  }
}

// ─── Accessors ─────────────────────────────────────────────────────────────

function getConnectionState(): ProviderStatus {
  return getGlobal().connectionState;
}

function setConnectionState(state: ProviderStatus) {
  getGlobal().connectionState = state;
}

function setQRCode(code: string | null) {
  const g = getGlobal();
  g.qrCodeRaw = code;
  g.qrCodeBase64 = null; // Invalida cache PNG
  g.qrCreatedAt = code ? Date.now() : null;
}

/** Retorna o QR Code como PNG base64 pronto para <img src="data:image/png;base64,...">. */
async function getQRCode(): Promise<string | null> {
  const g = getGlobal();
  if (!g.qrCodeRaw) {
    g.qrCodeBase64 = null;
    return null;
  }
  if (g.qrCodeBase64) return g.qrCodeBase64;
  try {
    const dataUrl = await QRCode.toDataURL(g.qrCodeRaw, {
      type: "image/png",
      margin: 1,
      width: 300,
      color: { dark: "#000000", light: "#ffffff" },
    });
    g.qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    console.log(`[Baileys] PNG base64 gerado (${g.qrCodeBase64.length} chars)`);
    return g.qrCodeBase64;
  } catch (err) {
    console.error("[Baileys] Erro ao gerar PNG do QR:", err);
    return null;
  }
}

/**
 * Fotografia do QR para a API: imagem + idade. A UI usa `createdAt` para saber se o
 * QR é o mesmo que já estava na tela (evita toast repetido) e para mostrar a idade.
 */
export async function getQrSnapshot() {
  const g = getGlobal();
  const qrCode = await getQRCode();
  return {
    qrCode,
    createdAt: qrCode ? g.qrCreatedAt : null,
    ageMs: qrCode && g.qrCreatedAt ? Date.now() - g.qrCreatedAt : null,
    status: g.connectionState.status,
    detail: g.connectionState.detail ?? null,
    lastStatusCode: g.lastStatusCode,
    reconnectAttempts: g.reconnectAttempts,
    /** true entre escanear o QR e o login se concluir (o WhatsApp manda reiniciar o socket). */
    justPaired: g.pairedRecently,
  };
}

/** Espera (até `ms`) o primeiro QR Code aparecer ou a conexão abrir. */
export async function waitForQr(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const g = getGlobal();
    if (g.qrCodeRaw || g.connectionState.status === "CONNECTED") return;
    await delay(250);
  }
}

// ─── Helpers de persistência ───────────────────────────────────────────────

/**
 * Persiste o estado da conexão.
 *
 * Antes era um `update({ status })` solto. Agora delega ao `ingestConnection`, que mantém
 * WhatsAppConnection, WhatsAppAccount, WhatsAppSession e a trilha de Logs coerentes e avisa
 * as telas abertas pelo barramento (§2, §19). O estado em memória (`setConnectionState`)
 * continua sendo a fonte do `waitForQr`/`ensureConnected`.
 */
async function saveConnectionState(orgId: string, status: string, phone?: string | null) {
  try {
    await ingestConnection(orgId, {
      state: toCanonicalConnectionState(status),
      detail: getConnectionState().detail,
      provider: providerName(),
      jid: getGlobal().account?.jid ?? null,
      lid: getGlobal().account?.lid ?? null,
      phone: phone ?? getGlobal().account?.phone ?? null,
      accountName: getGlobal().account?.name ?? null,
    });
  } catch (err) {
    console.error("[Baileys] Erro ao salvar estado no banco:", err);
  }
}

/** Nome do provedor tal como a configuração o declara (nunca deduzido de dentro do socket). */
function providerName(): string {
  return (process.env.WHATSAPP_PROVIDER ?? "bariels").toLowerCase() === "dev" ? "mock" : "bariels";
}

/**
 * Vocabulário interno do Baileys (CONNECTED/PENDING_QR/...) → estado canônico da tela (§2).
 * `PENDING_QR` só é "Aguardando QR Code" quando existe um QR de verdade na memória; antes
 * disso é "Conectando", e a tela mostra o passo certo em vez de um QR que ainda não chegou.
 */
function toCanonicalConnectionState(status: string): ConnectionState {
  switch (status) {
    case "CONNECTED":
      return "CONNECTED";
    case "ERROR":
      return "ERROR";
    case "DISCONNECTED":
      return "DISCONNECTED";
    case "RECONNECT_REQUIRED":
      return "RECONNECT_REQUIRED";
    default:
      return getGlobal().qrCodeRaw ? "WAITING_QR" : "CONNECTING";
  }
}

function reasonLabel(code: number | null | undefined) {
  if (code == null) return "motivo desconhecido";
  return REASON_LABELS[code] ?? `código ${code}`;
}

// ─── Processamento de mensagens ────────────────────────────────────────────

/**
 * Chegou uma mensagem do socket: normalizamos e entregamos ao `ingestEvent`, que é o
 * ÚNICO caminho que escreve contato/conversa/mensagem no banco (§regra final do prompt).
 * Este arquivo cuida do socket; ninguém aqui decide como se persiste.
 *
 * Diferente do código antigo, não descartamos mais o eco (`fromMe`): enviar pelo celular do
 * barbeiro também é atendimento, e o histórico da tela precisa mostrar os dois lados. A
 * duplicação com o INSERT do nosso próprio envio é resolvida pela idempotência por
 * `providerMsgId` dentro do ingest.
 */
async function processMessage(message: proto.IWebMessageInfo) {
  try {
    if (!message.key?.remoteJid) return;

    const orgId = getGlobal().orgId;
    if (!orgId) return;

    const normalized = normalizeWebMessage(message);
    if (!normalized) return;

    console.log(
      `[Baileys] 📥 ${normalized.direction === "outgoing" ? "eco de mensagem nossa" : "recebida"} de ${normalized.jid}${
        normalized.masked ? " (número mascarado pelo WhatsApp)" : ""
      }: "${normalized.text.slice(0, 60)}"`
    );

    await ingestEvent({ type: "message.upsert", orgId, message: normalized });
  } catch (err) {
    console.error("[Baileys] Erro ao processar mensagem:", err);
  }
}

// ─── Timers ────────────────────────────────────────────────────────────────

function clearReconnectTimer() {
  const g = getGlobal();
  if (g.reconnectTimer) {
    clearTimeout(g.reconnectTimer);
    g.reconnectTimer = null;
  }
}

function clearQrWatchdog() {
  const g = getGlobal();
  if (g.qrWatchdog) {
    clearTimeout(g.qrWatchdog);
    g.qrWatchdog = null;
  }
}

/**
 * Rede de segurança: se o socket ficou vivo mas nenhum QR apareceu (porque as
 * credenciais locais ainda apontam para uma sessão morta), derruba o socket,
 * apaga a sessão e recomeça do zero — garantindo um QR novo.
 */
function armQrWatchdog(orgId: string) {
  const g = getGlobal();
  clearQrWatchdog();
  g.qrWatchdog = setTimeout(() => {
    g.qrWatchdog = null;
    const state = getGlobal();
    if (state.sock !== g.sock) return;
    if (state.connectionState.status === "CONNECTED" || state.qrCodeRaw) return;
    if (state.starting) return;

    // QR escaneado há pouco: o recomeço é com a credencial nova, nunca apagando ela.
    if (state.pairedRecently) {
      console.warn("[Baileys] ⏱️ Sem QR/abertura após parear; reiniciando mantendo a sessão.");
      void restartSocket(g.orgId ?? orgId, "watchdog pós-pareamento", { wipe: false });
      return;
    }

    console.warn(
      `[Baileys] ⏱️ Nenhum QR Code em ${QR_WATCHDOG_MS / 1000}s com a sessão salva. ` +
        `Reiniciando com credenciais limpas para forçar um QR novo.`
    );
    void restartWithFreshQr(orgId, "watchdog");
  }, QR_WATCHDOG_MS);
}

function scheduleReconnect(orgId: string, delayMs: number) {
  const g = getGlobal();
  clearReconnectTimer();
  g.reconnectTimer = setTimeout(() => {
    g.reconnectTimer = null;
    const state = getGlobal();
    // Nunca criamos um segundo socket enquanto já existe um vivo.
    if (state.sock) {
      console.log("[Baileys] Reconexão agendada cancelada: já existe um socket ativo.");
      return;
    }
    state.isConnecting = false;
    void initBaileys(orgId).catch((err) =>
      console.error("[Baileys] Falha na reconexão agendada:", err)
    );
  }, delayMs);
}

/**
 * Garante que, depois de clicar em "Conectar", a situação termine em uma de três
 * coisas: conectado, QR na tela, ou estado de erro com `detail` explicativo.
 * Se a sessão salva ficar muda (nem abre, nem manda QR), refazemos com sessão limpa.
 */
export async function ensureQrOrConnected(orgId: string, opts: { freshQr?: boolean } = {}) {
  const g = getGlobal();

  if (opts.freshQr) {
    await restartWithFreshQr(orgId, "solicitado pelo usuário");
    await waitForQr(12_000);
    return;
  }

  if (g.connectionState.status === "CONNECTED") return;

  await initBaileys(orgId);
  await waitForQr(12_000);

  const after = getGlobal();
  if (after.qrCodeRaw || after.connectionState.status === "CONNECTED") return;
  if (!after.sock) return; // init falhou de forma explícita; o estado já diz o porquê
  if (after.pairedRecently) return; // QR já foi escaneado; apagar a credencial quebraria o login

  console.warn("[Baileys] Nenhum QR em 12s com a sessão salva. Refazendo com sessão limpa.");
  await restartWithFreshQr(orgId, "sessão salva não gerou QR");
  await waitForQr(12_000);
}

// ─── Socket ────────────────────────────────────────────────────────────────

/** Encerra o socket atual e descarta seus listeners. Não apaga credenciais. */
function teardownSocket() {
  const g = getGlobal();
  const current = g.sock;
  if (!current) return;

  // Invalida eventos futuros deste socket antes de mexer em qualquer estado.
  g.generation += 1;
  g.sock = null;

  clearQrWatchdog();
  setQRCode(null);

  for (const [event, listener] of [...(current.__baileysListeners ?? [])]) {
    try {
      (current.ev as any).off(event, listener);
    } catch {}
  }
  if (current.__baileysListeners) current.__baileysListeners.length = 0;

  try {
    current.end(undefined);
  } catch {}
}

/**
 * Derruba o socket atual e sobe outro.
 * `wipe: true`  → apaga as credenciais: o próximo start obrigatoriamente emite QR novo.
 * `wipe: false` → mantém a sessão: é o caminho certo logo depois de escanear o QR
 *                 (o WhatsApp manda reiniciar o socket e o login se conclui com a credencial nova).
 */
async function restartSocket(orgId: string, source: string, opts: { wipe: boolean }) {
  const g = getGlobal();
  console.log(
    `[Baileys] ♻️ Reiniciando socket (origem: ${source}, credenciais: ${opts.wipe ? "apagadas" : "mantidas"})`
  );
  // Se houver um init em andamento, deixe terminar: ele ainda está usando as
  // credenciais antigas em memória e seria substituído na sequência.
  if (g.starting) {
    try {
      await g.starting;
    } catch {}
  }
  clearReconnectTimer();
  g.reconnectAttempts = 0;
  g.isConnecting = false;
  teardownSocket();

  if (opts.wipe) {
    await clearAuthDir(orgId);
    g.pairedRecently = false;
    setConnectionState({ status: "PENDING_QR", detail: "Gerando um novo QR Code..." });
  } else {
    setConnectionState({
      status: "PENDING_QR",
      detail: "Aparelho pareado - concluindo o login no WhatsApp...",
    });
  }
  await saveConnectionState(orgId, "PENDING_QR");
  await initBaileys(orgId);
}

/** Encerra tudo e remove as credenciais, de modo que o próximo start emite QR novo. */
export async function restartWithFreshQr(orgId: string, source = "manual") {
  await restartSocket(orgId, source, { wipe: true });
}

async function openSocket(orgId: string) {
  const g = getGlobal();

  setConnectionState({
    status: "PENDING_QR",
    detail: hasSavedSession(orgId)
      ? "Restaurando sessão conhecida..."
      : "Sessão nova: aguardando QR Code do WhatsApp...",
  });

  console.log(`[Baileys] Carregando credenciais de ./baileys_auth_${orgId}/`);
  const { state, saveCreds } = await useMultiFileAuthState(`./baileys_auth_${orgId}`);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[Baileys] Versão WA: ${version.join(".")}, Latest: ${isLatest}`);

  /**
   * O Baileys loga no estilo pino: logger.error({ error, node }, 'mensagem'). Sem imprimir o
   * objeto, linhas como "error in handling message" e "received error in ack" viram ruído sem
   * diagnóstico — e são justamente elas que dizem se uma mensagem foi recusada pelo servidor.
   */
  const waLogLine = (args: any[]): string => {
    const obj = args.find((a) => a && typeof a === "object" && !(a instanceof Error));
    // No pino o texto pode vir como argumento OU dentro do objeto ({ msg: 'recv xml' }).
    const text =
      args.find((a) => typeof a === "string") ??
      (typeof obj?.msg === "string" ? obj.msg : undefined);
    const e = obj?.err ?? obj?.error;
    const pieces: string[] = [`[Baileys:WA] ${text ?? "aviso"}`];
    const detail = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
    if (detail) pieces.push(`erro=${detail}`);
    // Stack do próprio Baileys: sem ele, "error in handling message" diz que algo quebrou
    // mas não onde — e é isso que separa bug nosso de bug da lib.
    if (e instanceof Error && e.stack) {
      const frames = e.stack.split("\n").slice(1, 4).map((l) => l.trim().replace(/^at\s+/, ""));
      if (frames.length) pieces.push(`em ${frames.join(" ← ")}`);
    }
    const code = typeof e === "object" ? (e as any)?.output?.statusCode : undefined;
    if (typeof code === "number") pieces.push(`código=${code} (${reasonLabel(code)})`);
    const safeJson = (v: unknown) => {
      try {
        return JSON.stringify(v);
      } catch {
        return "<não serializável>";
      }
    };
    if (obj?.attrs) pieces.push(`attrs=${safeJson(obj.attrs)}`);
    else if (obj?.node?.attrs) pieces.push(`stanza=${safeJson(obj.node.attrs)}`);
    // trace: o Baileys escreve o nó inteiro (o que saiu e o que chegou) como XML em obj.xml.
    // É aqui que aparece o <receipt type="delivery"> do celular do destinatário — ou o
    // <node error="..."> do servidor. Sem colapsar as quebras, cada nó vira 20 linhas.
    else if (typeof obj?.xml === "string") {
      // 6000 chars: a lista de endereços (lid ↔ pn_jid) que o WhatsApp manda no login é
      // justamente onde está o número do destinatário — cortando em 900 ela fica ilegível.
      pieces.push(obj.xml.replace(/\s+/g, " ").slice(0, 6000));
    }
    else if (obj) {
      const simple = Object.fromEntries(
        Object.entries(obj).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
      );
      if (Object.keys(simple).length) pieces.push(safeJson(simple));
    }
    return pieces.join(" | ");
  };

  /**
   * BAILEYS_LOG_LEVEL=debug|trace imprime o tráfego bruto do WebSocket — é a única forma de
   * ver se o servidor devolveu um recibo (delivery/read) ou um erro de stanza para o ID que
   * enviamos. Com "warn" (padrão) a gente só sabe que o sendMessage respondeu; com "trace"
   * aparece cada nó recebido, inclusive os `<receipt>` que viram DELIVERED na tela.
   * Barulhento de propósito: use só durante o diagnóstico e volte para warn depois.
   */
  const LEVELS: Record<string, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
  const waThreshold = LEVELS[(process.env.BAILEYS_LOG_LEVEL ?? "warn").toLowerCase()] ?? 2;
  const waEmit = (min: number) =>
    waThreshold >= min ? (...args: any[]) => console.log(waLogLine(args)) : () => waLogger;

  const waLogger = {
    level: (process.env.BAILEYS_LOG_LEVEL ?? "warn").toLowerCase(),
    fatal: () => waLogger,
    error: (...args: any[]) => console.error(waLogLine(args)),
    warn: (...args: any[]) => console.warn(waLogLine(args)),
    info: waEmit(3),
    debug: waEmit(4),
    trace: waEmit(5),
    child: () => waLogger,
  } as any;

  const generation = g.generation + 1;

  console.log("[Baileys] Criando WASocket...");
  const newSock = makeWASocket({
    version,
    auth: state,
    logger: waLogger,
    browser: ["SaaS Clínica", "Chrome", "1.0"],
    /**
     * Os dois abaixo são o motivo de ter subido para a 7. Quando o celular do destinatário
     * não descriptografa, ele devolve `<receipt type='retry'>` trazendo o key bundle dele:
     *
     *  - enableRecentMessageCache: o Baileys guarda a mensagem que ELE mandou (MessageRetry
     *    Manager) e consegue reenviá-la quando o retry chega. Na 6.7.x isso dependia de
     *    `getMessage()`, que nós não passamos — por isso o log tinha "recv retry request, but
     *    message not available" e a mensagem morria em retry para sempre.
     *  - enableAutoSessionRecreation: descarta a sessão Signal podre quando o retry persiste
     *    (códigos MAC 4/7), forçando handshake novo em vez de repetir o mesmo cifrado ruim.
     *
     * Já vêm `true` no DEFAULT_CONNECTION_CONFIG da 7.0.0-rc14; deixo explícito porque uma
     * mudança de default silenciosa recria exatamente o bug que perseguimos em 27/10.
     */
    enableRecentMessageCache: true,
    enableAutoSessionRecreation: true,
    // O eco das mensagens que o barbeiro manda pelo celular chega com o @lid da PRÓPRIA
    // conta. O Baileys 6.7 não decodifica esse caso e quebra dentro do processamento
    // ("Cannot read properties of null (reading 'toString')"), derrubando a mensagem antes
    // de emitir messages.upsert. Ignorar o nosso próprio LID evita o crash.
    shouldIgnoreJid: (jid: string) => {
      const meLid = state.creds.me?.lid as string | undefined;
      if (!meLid || !jid) return false;
      return jid.split(":")[0] === meLid.split(":")[0] && jid.endsWith("@lid");
    },
  }) as any;

  // Fallback de TS: a extensão abaixo não existe no tipo oficial do Baileys.
  const sock = newSock as TrackedSocket;
  sock.__baileysListeners = [];
  g.generation = generation;
  g.sock = sock;
  console.log(`[Baileys] WASocket criado (gen=${generation}), registrando listeners...`);

  const onConnectionUpdate = async (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    const gnow = getGlobal();

    if (gnow.generation !== generation) {
      console.log(`[Baileys] Ignorando evento de socket obsoleto (gen=${generation}, atual=${gnow.generation})`);
      return;
    }

    console.log(
      `[Baileys] connection.update → connection=${connection ?? "null"} qr=${qr ? `<${qr.length} chars>` : "null"} isNewLogin=${update.isNewLogin ? "SIM" : "não"}`
    );

    // O QR foi escaneado e o aparelho foi pareado. Logo em seguida o WhatsApp fecha este
    // socket pedindo reinício (515): a próxima conexão tem que usar a credencial que
    // acabou de ser criada — apagá-la aqui é o que impedia a conexão de finalizar.
    if (update.isNewLogin) {
      const g2 = getGlobal();
      g2.pairedRecently = true;
      g2.reconnectAttempts = 0;
      clearQrWatchdog();
      setQRCode(null);
      console.log("[Baileys] 📲 Aparelho pareado! Gravando credenciais e concluindo o login...");
      try {
        await saveCreds();
      } catch (err) {
        console.error("[Baileys] Falha ao gravar as credenciais do pareamento:", err);
      }
      setConnectionState({
        status: "PENDING_QR",
        detail: "Aparelho pareado - concluindo o login no WhatsApp...",
      });
      return;
    }

    if (qr) {
      setQRCode(qr);
      setConnectionState({
        status: "PENDING_QR",
        detail: "QR Code gerado - escaneie com WhatsApp",
      });
      await saveConnectionState(orgId, "PENDING_QR");
      // A tela em frente enxerga o QR novo sem esperar o próximo poll (§3, §19).
      ingestQr(orgId, qr);
      clearQrWatchdog();
      console.log(`[Baileys] ✅ QR salvo em memória (${qr.length} chars)`);
      return;
    }

    if (connection === "open") {
      const g2 = getGlobal();
      g2.reconnectAttempts = 0;
      g2.lastStatusCode = null;
      g2.pairedRecently = false;
      clearQrWatchdog();
      clearReconnectTimer();
      setConnectionState({ status: "CONNECTED", detail: "Conectado" });
      setQRCode(null);
      const me = state.creds.me as { id?: string; lid?: string; name?: string } | undefined;
      const phone = me?.id ? jidNormalizedUser(me.id).replace(/\D/g, "") : null;
      g2.account = {
        jid: me?.id ? jidNormalizedUser(me.id) : null,
        lid: me?.lid ? String(me.lid) : null,
        phone,
        name: me?.name ?? null,
      };
      await saveConnectionState(orgId, "CONNECTED", phone);
      g2.isConnecting = false;
      console.log(`[Baileys] ✅ Conectado com sucesso! (${me?.name ?? "sem nome"} / ${phone ?? "?"})`);
      return;
    }

    if (connection === "connecting") {
      setConnectionState({
        status: "PENDING_QR",
        detail: hasSavedSession(orgId)
          ? "Restaurando sessão conhecida..."
          : "Contatando o WhatsApp, aguardando QR Code...",
      });
      armQrWatchdog(orgId);
      return;
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
      const label = reasonLabel(statusCode);
      const g2 = getGlobal();
      g2.lastStatusCode = statusCode ?? null;
      console.log(`[Baileys] ❌ Desconectado: ${label}`);

      // Este socket morreu; qualquer evento dele deixa de interessar.
      g2.generation += 1;
      g2.sock = null;
      clearQrWatchdog();
      setQRCode(null);
      try {
        sock.end(undefined);
      } catch {}

      const justPaired = g2.pairedRecently;
      g2.pairedRecently = false;
      const terminal = statusCode != null && TERMINAL_CODES.includes(statusCode);
      const authBroken =
        !justPaired && statusCode != null && AUTH_INVALID_CODES.includes(statusCode);

      if (terminal) {
        // Banimento / incompatibilidade: insistir (ou apagar a pasta) não resolve.
        g2.isConnecting = false;
        setConnectionState({
          status: "ERROR",
          detail: `${label}. Resolva no WhatsApp do celular e clique em "Gerar novo QR".`,
        });
        await saveConnectionState(orgId, "ERROR");
        console.warn("[Baileys] Parando de reconectar: motivo terminal.");
        return;
      }

      if (justPaired) {
        // Reinício logo depois de escanear: mantém a credencial nova e reconecta rápido.
        g2.reconnectAttempts = 0;
        g2.isConnecting = false;
        try {
          await saveCreds();
        } catch (err) {
          console.error("[Baileys] Falha ao gravar credenciais no pós-pareamento:", err);
        }
        setConnectionState({
          status: "PENDING_QR",
          detail: "Aparelho pareado - concluindo o login no WhatsApp...",
        });
        await saveConnectionState(orgId, "PENDING_QR");
        console.log(`[Baileys] 🔁 Reconectando com a sessão pareada (${label})...`);
        scheduleReconnect(orgId, 1200);
        return;
      }

      if (authBroken) {
        // Credenciais mortas: sem apagar a pasta, o WhatsApp nunca reenvia um QR Code.
        g2.reconnectAttempts = 0;
        g2.isConnecting = false;
        await clearAuthDir(orgId);
        setConnectionState({
          status: "PENDING_QR",
          detail: `Sessão antiga invalidada (${label}). Gerando novo QR Code...`,
        });
        await saveConnectionState(orgId, "PENDING_QR");
        scheduleReconnect(orgId, 1500);
        return;
      }

      const attempt = g2.reconnectAttempts + 1;
      g2.reconnectAttempts = attempt;
      g2.isConnecting = false;

      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        setConnectionState({
          status: "DISCONNECTED",
          detail: `${MAX_RECONNECT_ATTEMPTS} tentativas automáticas falharam (${label}). Clique em "Gerar novo QR Code".`,
        });
        await saveConnectionState(orgId, "DISCONNECTED");
        console.warn("[Baileys] Desistindo de reconectar automaticamente.");
        return;
      }

      const wait = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      setConnectionState({
        status: "PENDING_QR",
        detail: `Reconectando (${label}) — tentativa ${attempt}/${MAX_RECONNECT_ATTEMPTS}`,
      });
      await saveConnectionState(orgId, "PENDING_QR");
      console.log(`[Baileys] Nova tentativa em ${wait / 1000}s...`);
      scheduleReconnect(orgId, wait);
    }
  };

  const onCredsUpdate = () => {
    if (getGlobal().generation !== generation) return;
    void saveCreds().catch((err: any) =>
      console.error("[Baileys] Erro ao salvar credenciais:", err?.message ?? err)
    );
  };

  const onMessagesUpsert = async ({ messages, type }: any) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      await processMessage(msg);
    }
  };

  const onMessagesUpdate = async (updates: any) => {
    const orgId = getGlobal().orgId;
    if (!orgId) return;

    for (const raw of updates ?? []) {
      // O Baileys emite { key, update: { status } } — não o objeto inteiro.
      const key = raw?.key;
      const status = raw?.update?.status ?? raw?.status;
      if (!key?.fromMe || !key?.id) continue;

      const ack = normalizeAck(status);
      const nextStatus = statusFromAck(status);
      if (!nextStatus) continue;

      const detail =
        nextStatus === "failed"
          ? (raw?.update?.messageStubParameters?.join(" ") ?? "WhatsApp recusou a mensagem")
          : undefined;

      console.log(`[Baileys] 📩 recibo msg=${key.id} ack=${ack} → ${nextStatus.toUpperCase()}`);

      // Quem decide como persistir (e se o status pode avançar) é o ingest — não o socket.
      await ingestEvent({
        type: "message.status",
        orgId,
        providerMsgId: key.id,
        jid: key.remoteJid ?? undefined,
        status: nextStatus,
        detail,
      }).catch((err) => console.error("[Baileys] Erro ao aplicar recibo:", err));
    }
  };

  const register = (event: string, listener: (...a: any[]) => void) => {
    (sock.ev as any).on(event, listener);
    sock.__baileysListeners.push([event, listener]);
  };

  register("connection.update", onConnectionUpdate);
  register("creds.update", onCredsUpdate);
  register("messages.upsert", onMessagesUpsert);
  register("messages.update", onMessagesUpdate);

  console.log("[Baileys] ✅ Listeners registrados. Aguardando QR ou conexão...");
  armQrWatchdog(orgId);
}

// ─── Init (single-flight) ──────────────────────────────────────────────────

async function initBaileys(orgId: string) {
  const g = getGlobal();

  if (g.sock) {
    console.log("[Baileys] Já existe um socket ativo — nada a fazer.");
    return;
  }
  if (g.starting) {
    console.log("[Baileys] Inicialização em andamento — aguardando a mesma terminar.");
    return g.starting;
  }

  console.log(`[Baileys] initBaileys chamado para orgId=${orgId}`);
  g.orgId = orgId;

  // Identificador desta inicialização: só ela pode limpar g.starting ao terminar.
  const startSeq = ++g.startSeq;

  const run = (async () => {
    g.isConnecting = true;
    try {
      await openSocket(orgId);
    } catch (err) {
      console.error("[Baileys] ❌ Erro na inicialização:", err);
      setConnectionState({
        status: "ERROR",
        detail: err instanceof Error ? err.message : "Erro desconhecido ao iniciar o Baileys",
      });
      g.isConnecting = false;
      await saveConnectionState(orgId, "ERROR").catch(() => {});
    } finally {
      if (getGlobal().startSeq === startSeq) getGlobal().starting = null;
    }
  })();

  g.starting = run;
  return run;
}

// ─── Send ──────────────────────────────────────────────────────────────────

// A tradução ACK → status mora em `normalize.ts`, que é a mesma usada pelo caminho de
// recebimento. Deixar duas tabelas no projeto foi o que permitiu "SENT" significar uma
// coisa no envio e outra no recibo.
//
// "SENT" aqui significa apenas que o SERVIDOR do WhatsApp aceitou o texto (SERVER_ACK). Só
// vira DELIVERED quando o celular do destinatário confirma o recebimento, via messages.update.
// Confundir os dois esconde problemas reais (número sem conta, destinatário bloqueando, sessão
// nova em review de spam).
//
// PENDING significa "o frame saiu do nosso socket, mas o servidor não devolveu <ack> em 20s" —
// é exatamente o caso que passou meses disfarçado de "enviada". PENDING fica PENDING e aparece
// como "Aguardando servidor".

/**
 * Mapeia o telefone para um JID e confere no servidor do WhatsApp se aquele número tem conta.
 *
 * Regra: só mandamos para um jid que o servidor CONFIRME para o número consultado. Aceitar
 * `results[0]` sem conferir pode mandar o texto para o chat de outra pessoa (SERVER_ACK,
 * "SENT" na tela, ninguém recebe).
 *
 * Conferência tem duas camadas, porque o WhatsApp normaliza número brasileiro:
 *  - igualdade exata dos dígitos, e
 *  - igualdade depois de colapsar a forma antiga de celular BR (55+DDD+8 dígitos ≡
 *    55+DDD+9 dígitos). Isso não é palpite: medido em 27/10/2026, `onWhatsApp("5531987707962")`
 *    devolve `jid=553187707962@s.whatsapp.net` com o MESMO `lid` que a consulta de
 *    `553187707962` devolve — uma conta só. Mandar em `5531987707962@s.whatsapp.net` (o jid
 *    "canônico") é exatamente o que produz SENT sem DELIVERED.
 */
export async function resolveJid(
  sock: TrackedSocket,
  phone: string
): Promise<{ jid?: string; error?: string; exists?: boolean; targetKind?: string }> {
  const digits = toWhatsAppDigits(phone);
  if (!digits) {
    return {
      error:
        `"${phone}" não é um número de telefone discável (precisa de DDI + DDD, ex.: 5531987707962). ` +
        "Números mascarados pelo WhatsApp (@lid) não servem para enviar.",
    };
  }
  if (digits.length < 10 || digits.length > 15) {
    return { error: `Número "${phone}" parece incompleto. Use DDI + DDD, ex.: 5531987707962.` };
  }

  const canonicalJid = `${digits}@s.whatsapp.net`;
  /** Parte local (antes de @ e de :) de um jid, como dígitos puros. */
  const localDigits = (jid: unknown): string =>
    String(jid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");

  /** Variante alternativa do celular BR: 8 dígitos vs 9 dígitos (o 9º dígito só existe desde 2016). */
  const brAlternate = (d: string): string | null => {
    if (d.startsWith("55")) {
      if (d.length === 13) {
        const rest = d.slice(4);
        if (rest.length === 9 && rest[0] === "9") {
          return `55${d.slice(2, 4)}${rest.slice(1)}`;
        }
      } else if (d.length === 12) {
        const rest = d.slice(4);
        if (rest.length === 8 && ["6", "7", "8", "9"].includes(rest[0])) {
          return `55${d.slice(2, 4)}9${rest}`;
        }
      }
    }
    return null;
  };
  const alternate = brAlternate(digits);

  try {
    let results: any[] = (await (sock as any).onWhatsApp(digits)) ?? [];
    if (results.length === 0 && alternate) {
      // Se não achou na forma informada (ex.: 13 dígitos), tenta na forma alternativa (ex.: 12 dígitos)
      const fallbackResults = (await (sock as any).onWhatsApp(alternate)) ?? [];
      if (fallbackResults.length > 0) results = fallbackResults;
    }
    /** `exacta` = mesmo número; `normalizada` = mesmo número na forma alternativa BR (8 vs 9 dígitos). */
    const classify = (r: any): "exacta" | "normalizada" | null => {
      for (const candidate of [localDigits(r?.jid), localDigits(r?.lid)]) {
        if (!candidate) continue;
        if (candidate === digits) return "exacta";
        if (alternate && candidate === alternate) return "normalizada";
      }
      return null;
    };
    let matchMode: "exacta" | "normalizada" | null = null;
    const hit = results.reduce<any>((best, r) => {
      const mode = classify(r);
      if (!mode) return best;
      if (!best.mode || (mode === "exacta" && best.mode === "normalizada")) return { r, mode };
      return best;
    }, {}) as { r?: any; mode?: "exacta" | "normalizada" };
    matchMode = hit.mode ?? null;

    if (results.length && !hit.r) {
      console.warn(
        `[Baileys] onWhatsApp(${digits}) respondeu ${results.length} entrada(s), nenhuma do número ` +
          `consultado: ${JSON.stringify(results)}. Enviando no número canônico para não cair em outro chat.`
      );
      return { jid: canonicalJid, exists: undefined, targetKind: "canonical" };
    }
    if (!hit.r) {
      // Lista vazia = sem conta (ou consulta não retornou nada): não enviamos às cegas.
      return {
        exists: false,
        error: `O número ${digits} não tem conta do WhatsApp (ou o DDI/DDD está errado). O servidor aceita o texto, mas nunca entrega.`,
      };
    }
    const found = hit.r;

    const exists = Boolean(found.exists);
    const lid = typeof found.lid === "string" && found.lid.includes("@lid") ? found.lid : null;
    console.log(
      `[Baileys] onWhatsApp(${digits}) → exists=${exists} jid=${found.jid ?? "?"} lid=${lid ?? "nenhum"} ` +
        `tipo=${found.type ?? "?"} plataforma=${found.platform ?? "?"} conferência=${matchMode}`
    );
    if (matchMode === "normalizada") {
      console.log(
        `[Baileys] ⚠️ o servidor confirmou ${digits} como ${found.jid} (celular BR na forma de 8 dígitos). ` +
          `Enviando nesse jid — em ${canonicalJid} o WhatsApp aceita e nunca entrega.`
      );
    }
    if (!exists) {
      return {
        exists: false,
        error: `O número ${digits} não tem conta do WhatsApp (ou o DDI/DDD está errado). O servidor aceita o texto, mas nunca entrega.`,
      };
    }

    /**
     * Desde a migração para usernames, o roteamento real do par pode ser o @lid. Em
     * 6.7.x enviar para @lid ainda não é confiável, então o padrão continua sendo o
     * jid de telefone; WHATSAPP_USE_LID=1 manda para o @lid quando existir, para você
     * testar a entrega sem mudar mais nada.
     */
    const useLid = process.env.WHATSAPP_USE_LID === "1" && lid;
    return {
      jid: useLid ? lid! : (found.jid ?? canonicalJid),
      exists: true,
      targetKind: useLid ? "lid" : matchMode === "normalizada" ? "phone-normalizado" : "phone",
    };
  } catch (err: any) {
    // Consulta de disponibilidade falhou (rede/versão): não bloqueamos o envio por isso.
    console.warn(`[Baileys] onWhatsApp(${digits}) falhou, enviando sem confirmar: ${err?.message ?? err}`);
    return { jid: canonicalJid, exists: undefined, targetKind: "canonical" };
  }
}


/**
 * Confirmação real de envio, lida direto do WebSocket.
 *
 * A 6.x tinha `waitForAck: true` no `sendMessage`; a 7.x removeu a opção (não existe em
 * `AnyMessageContent` nem em `MiscMessageGenerationOptions`), então `sendMessage` volta assim
 * que o frame é escrito no socket — o que NÃO prova que o servidor aceitou a mensagem.
 *
 * Como recovered: cada frame recebido é reemitido como evento `TAG:<attrs.id>` no cliente de
 * WebSocket (`Socket/socket.js`, `onMessageReceived`), e o `<ack>`/`<receipt>` do WhatsApp traz
 * o ID da mensagem nesse atributo. Esperar esse evento é a única forma honesta de dizer
 * "aceita pelo servidor" em vez de "saiu da minha máquina".
 *
 * Primeiro `<ack>` encerra a espera. Delivery/read continuam chegando por `messages.update`
 * (onMessagesUpdate grava no banco). `<receipt type='retry'>` só registra no log e segue
 * esperando: com `enableRecentMessageCache` + `enableAutoSessionRecreation` o próprio Baileys
 * injeta a sessão do bundle, reenvia a mesma mensagem e o ack do reenvio cai no mesmo ID.
 */
async function waitForAckFrame(
  sock: TrackedSocket,
  msgId: string,
  timeoutMs = 20_000
): Promise<{ ack: string; errorCode?: string } | null> {
  const ws: any = (sock as any)?.ws;
  if (!ws || typeof ws.on !== "function") return null;

  const event = `TAG:${msgId}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { ack: string; errorCode?: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.off?.(event, onFrame);
      } catch {
        /* listener já removido pelo socket ao fechar */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onFrame = (frame: any) => {
      const tag = frame?.tag;
      const attrs = frame?.attrs ?? {};
      if (tag === "ack") {
        if (attrs.error) return finish({ ack: "ERROR", errorCode: String(attrs.error) });
        return finish({ ack: "SERVER_ACK" });
      }
      if (tag === "receipt") {
        const type = String(attrs.type ?? "");
        if (type === "delivery") return finish({ ack: "DELIVERY_ACK" });
        if (type === "read" || type === "played") return finish({ ack: type.toUpperCase() });
        if (type === "retry") {
          console.warn(
            `[Baileys] 🔁 destinatário não descriptografou ${msgId} (retry) — o Baileys 7 está ` +
              `reconstruindo a sessão e reenviando; continuo esperando o ack.`
          );
        }
      }
    };
    ws.on(event, onFrame);
  });
}

/** Classifica o frame de confirmação no vocabulário do banco (PENDING nunca vira SENT). */
function statusFromAckFrame(frame: { ack: string; errorCode?: string } | null): string {
  if (!frame) return "PENDING";
  return toDbStatus(statusFromAck(frame.ack) ?? "pending");
}

/**
 * Alvo do envio: `jid` quando já conhecemos o par (contato mapeado, inclusive @lid), ou
 * `phone` quando precisamos consultar o servidor do WhatsApp.
 */
export type BaileysSendTarget = { phone?: string | null; jid?: string | null };

async function resolveTarget(sock: TrackedSocket, target: BaileysSendTarget) {
  const jid = target.jid?.trim();
  if (jid && jid.endsWith("@lid")) {
    // LID conhecido vem do WhatsApp ou pareamento
    return { jid, exists: true, targetKind: "lid" };
  }

  // Se temos telefone ou se o jid é @s.whatsapp.net, resolve o JID real com o servidor do WhatsApp
  // Isso é crítico no Brasil: números com 9 dígitos frequentemente estão registrados com 8 dígitos no WhatsApp (e vice-versa).
  const phone =
    target.phone ||
    (jid && jid.endsWith("@s.whatsapp.net")
      ? jid.split("@")[0].split(":")[0].replace(/\D/g, "")
      : null);

  if (!phone) {
    if (jid && jid.includes("@")) {
      return { jid, exists: undefined as boolean | undefined, targetKind: "phone" };
    }
    return { error: "Destinatário inválido: nem número nem jid." };
  }
  return resolveJid(sock, phone);
}

/**
 * Envia texto e espera a confirmação real do servidor.
 *
 * `phone` continua aceito para não quebrar quem já chama; `jid` é o caminho novo, usado pelo
 * serviço quando a conversa já tem um par mapeado (é o que permite falar com um @lid).
 */
async function sendToTarget(target: BaileysSendTarget, text: string): Promise<SendResult> {
  const currentSock = getGlobal().sock;
  if (!currentSock) {
    return { ok: false, error: "Baileys não conectado" };
  }

  try {
    const resolved = await resolveTarget(currentSock, target);
    if (resolved.error) {
      return { ok: false, error: resolved.error, recipientExists: resolved.exists };
    }
    const jid = resolved.jid!;

    const sent: any = await currentSock.sendMessage(jid, { text });
    // A 7.x devolve a WAMessage gerada; em alguns caminhos (e na 6.x) vem só o ID.
    const id: string | undefined =
      sent?.key?.id ?? (typeof sent === "string" ? sent : undefined);
    if (!id) {
      return { ok: false, error: "Mensagem enviada mas sem ID de confirmação", recipientExists: resolved.exists };
    }

    const frame = await waitForAckFrame(currentSock, id, 20_000);
    if (!frame) {
      console.warn(
        `[Baileys] ⏳ sendMessage(${jid}, id=${id}) não recebeu <ack> do servidor em 20s — ` +
          `o frame saiu do nosso socket, mas o WhatsApp não confirmou. Fica PENDING.`
      );
    }
    const ack = frame?.ack ?? normalizeAck(sent?.status) ?? null;

    if (ack === "ERROR") {
      const code = Number(frame?.errorCode);
      return {
        ok: false,
        providerMsgId: id,
        status: "FAILED",
        error:
          `O WhatsApp recusou a mensagem (código ${frame?.errorCode ?? "?"}: ` +
          `${reasonLabel(Number.isFinite(code) ? code : null)}).`,
        recipientExists: resolved.exists,
      };
    }

    const status = statusFromAckFrame(frame);
    console.log(
      `[Baileys] 📤 ${status === "SENT" ? "aceita pelo servidor" : status === "DELIVERED" || status === "READ" ? "entregue" : "sem ack do servidor"} para ${jid} ` +
        `(alvo=${resolved.targetKind ?? "phone"}) id=${id} ack=${ack ?? "nenhum"} — ` +
        `DELIVERED só chega quando o celular do destinatário confirmar`
    );

    return {
      ok: true,
      providerMsgId: id,
      ack: ack ?? undefined,
      status,
      recipientExists: resolved.exists,
      resolvedJid: jid,
    };
  } catch (err: any) {
    const statusCode = err?.output?.statusCode;
    const msg = err instanceof Error ? err.message : "Erro ao enviar";
    return {
      ok: false,
      error: statusCode ? `${msg} (código WhatsApp ${statusCode}: ${reasonLabel(statusCode)})` : msg,
    };
  }
}

async function sendBaileysMessage(phone: string, text: string): Promise<SendResult> {
  return sendToTarget({ phone }, text);
}

/** Aceita http(s) e data URL — o anexo nunca passa pelo navegador do cliente. */
async function bufferFromSource(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const base64 = url.slice(url.indexOf(",") + 1);
    return Buffer.from(base64, "base64");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Não foi possível baixar o anexo (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Envia anexo. Antes qualquer chamada virava `imageMessage`; agora o tipo segue o anexo
 * real (§7: imagem, documento, áudio, vídeo), porque mandar PDF como foto quebra no
 * WhatsApp do cliente.
 */
async function sendMediaToTarget(
  target: BaileysSendTarget,
  mediaUrl: string,
  caption?: string,
  kind: "image" | "video" | "audio" | "document" = "image",
  fileName?: string,
  mimeType?: string
): Promise<SendResult> {
  const currentSock = getGlobal().sock;
  if (!currentSock) {
    return { ok: false, error: "Baileys não conectado" };
  }

  try {
    const resolved = await resolveTarget(currentSock, target);
    if (resolved.error) {
      return { ok: false, error: resolved.error, recipientExists: resolved.exists };
    }
    const jid = resolved.jid!;

    const buffer = await bufferFromSource(mediaUrl);

    const content: Record<string, unknown> = { caption: caption ?? "" };
    if (kind === "video") content.video = buffer;
    else if (kind === "audio") {
      content.audio = buffer;
      content.ptt = true; // grifo de "mensagem de voz", não um arquivo de áudio comum
    } else if (kind === "document") {
      content.document = buffer;
      content.fileName = fileName ?? "anexo";
      content.mimetype = mimeType ?? "application/octet-stream";
    } else content.image = buffer;

    const sent: any = await currentSock.sendMessage(jid, content as any);
    const id: string | undefined = sent?.key?.id ?? (typeof sent === "string" ? sent : undefined);
    if (!id) {
      return { ok: false, error: "Mídia enviada mas sem ID de confirmação" };
    }

    // Mesma espera de <ack> do envio de texto: sem ela "enviada" quereria dizer
    // apenas "o frame foi escrito no WebSocket".
    const frame = await waitForAckFrame(currentSock, id, 20_000);
    const ack = frame?.ack ?? normalizeAck(sent?.status) ?? null;
    if (ack === "ERROR") {
      return {
        ok: false,
        providerMsgId: id,
        status: "FAILED",
        error: `O WhatsApp recusou a mídia (código ${frame?.errorCode ?? "?"}).`,
        recipientExists: resolved.exists,
      };
    }

    return {
      ok: true,
      providerMsgId: id,
      ack: ack ?? undefined,
      status: statusFromAckFrame(frame),
      recipientExists: resolved.exists,
      resolvedJid: jid,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Erro ao enviar mídia" };
  }
}

// ─── Provider class ────────────────────────────────────────────────────────

export class BaileysProvider implements WhatsAppProvider {
  readonly name = "baileys";

  async sendMessage(phone: string, body: string): Promise<SendResult> {
    return sendBaileysMessage(phone, body);
  }

  async sendTemplate(_phone: string, _templateKey: string, _body: string): Promise<SendResult> {
    return { ok: false, error: "Templates não suportados diretamente. Use sendMessage." };
  }

  async sendMedia(phone: string, mediaUrl: string, caption?: string): Promise<SendResult> {
    return sendMediaToTarget({ phone }, mediaUrl, caption);
  }

  async checkConnection(): Promise<ProviderStatus> {
    return getConnectionState();
  }

  async getStatus(): Promise<ProviderStatus> {
    return getConnectionState();
  }

  processWebhook(_raw: unknown): { externalId: string; status: string } | null {
    return null;
  }

  async connect(orgId: string): Promise<void> {
    await initBaileys(orgId);
  }

  async disconnect(orgId?: string): Promise<void> {
    const g = getGlobal();
    const targetOrgId = orgId ?? g.orgId;

    clearReconnectTimer();
    clearQrWatchdog();
    g.reconnectAttempts = 0;
    g.pairedRecently = false;

    const current = g.sock;
    if (current) {
      // Aposenta o socket antes de mexer no estado, para que o close não dispare
      // uma reconexão automática por cima do logout.
      g.generation += 1;
      g.sock = null;

      try {
        // logout() derruba o pareamento no WhatsApp e pode travar se o socket já
        // estiver meio morto — por isso o timeout curto e o catch.
        await Promise.race([
          current.logout().catch((err: any) =>
            console.error("[Baileys] logout rejeitado:", err?.message ?? err)
          ),
          delay(LOGOUT_TIMEOUT_MS),
        ]);
      } catch (err) {
        console.error("[Baileys] Erro ao fazer logout do socket:", err);
      }

      for (const [event, listener] of [...(current as any).__baileysListeners ?? []]) {
        try {
          (current.ev as any).off(event, listener);
        } catch {}
      }

      try {
        current.end(undefined);
      } catch {}
    }

    setQRCode(null);
    setConnectionState({ status: "DISCONNECTED", detail: "Desconectado manualmente" });
    g.isConnecting = false;
    g.startSeq += 1; // qualquer init em andamento perde a vez
    g.starting = null;

    if (targetOrgId) {
      await clearAuthDir(targetOrgId);
      try {
        await db.whatsAppConnection.update({
          where: { orgId: targetOrgId },
          data: { status: "DISCONNECTED", phone: null },
        });
      } catch (err) {
        console.error("[Baileys] Erro ao salvar desconexão no banco:", err);
      }
    }
    g.orgId = null;
  }
}

/**
 * Sobe a sessão (se necessário) e espera até o estado CONNECTED.
 * Usado pelo worker de jobs: sem isso, o primeiro envio depois de reiniciar o Next
 * falha com "Baileys não conectado: Não iniciado" porque ninguém chamou initBaileys.
 * Não apaga credenciais — retoma o pareamento salvo; se não houver pareamento, o
 * estado fica PENDING_QR e a função retorna esse estado (sem esperar QR para sempre).
 */
export async function ensureConnected(orgId: string, timeoutMs = 20_000): Promise<ProviderStatus> {
  const g = getGlobal();

  // Tenancy: existe UM socket por processo. Se ele pertence a outra barbearia, esta org está
  // desconectada — devolver o estado global aqui foi o que fez uma org de teste aparecer
  // "CONNECTED" e enviar mensagens pelo QR da org real.
  if (g.sock && g.orgId && g.orgId !== orgId) {
    return {
      status: "DISCONNECTED",
      detail: "O WhatsApp conectado pertence a outra clínica. Desconecte e conecte novamente aqui.",
    };
  }

  if (g.connectionState.status !== "CONNECTED") {
    if (!g.sock) {
      if (!hasPairedSession(orgId)) {
        return {
          status: "PENDING_QR",
          detail: "Nenhum pareamento salvo para esta organização: conecte escaneando o QR Code.",
        };
      }
      await initBaileys(orgId);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = getGlobal();
      if (state.connectionState.status === "CONNECTED") return state.connectionState;
      // QR pedido = a sessão salva não valeu mais; para de esperar e devolve o estado.
      if (state.qrCodeRaw) return state.connectionState;
      await delay(250);
    }
  }

  return getConnectionState();
}

export { getConnectionState, getQRCode, initBaileys, hasSavedSession, teardownSocket };

// ─── Superfície usada pelo BarielsAdapter ───────────────────────────────────
// O adapter é o único cliente destes exportadores. Eles existem para que a troca de socket
// por HTTP (Evolution, Cloud API) não vaze para o resto do CRM.

/** Org que é dona do socket agora — ou null quando não há socket. */
export function currentOwnerOrgId(): string | null {
  return getGlobal().orgId;
}

/** Conta pareada em memória (jid/lid/telefone/nome). */
export function getAccountInfo() {
  return getGlobal().account;
}

/**
 * Guarda de tenancy: com um socket só por processo, um envio da org B pelo socket da org A
 * publicaria a mensagem da barbearia errada (aconteceu em 27/10 com orgs de teste).
 */
function assertSocketOrg(orgId: string) {
  const g = getGlobal();
  if (!g.sock) {
    throw new Error("Baileys não conectado");
  }
  if (g.orgId && g.orgId !== orgId) {
    throw new Error(
      "O WhatsApp conectado pertence a outra clínica. Desconecte e conecte novamente nesta conta."
    );
  }
}

export async function baileysSendText(orgId: string, target: BaileysSendTarget, text: string) {
  assertSocketOrg(orgId);
  return sendToTarget(target, text);
}

export async function baileysSendMedia(
  orgId: string,
  target: BaileysSendTarget,
  mediaUrl: string,
  caption?: string,
  kind?: "image" | "video" | "audio" | "document",
  fileName?: string,
  mimeType?: string
) {
  assertSocketOrg(orgId);
  return sendMediaToTarget(target, mediaUrl, caption, kind, fileName, mimeType);
}

/** Estado ao vivo + QR, numa chamada só — é o que o adapter usa em getStatus/getQr. */
export async function baileysSnapshot(orgId: string) {
  const g = getGlobal();
  return {
    ownerOrgId: g.orgId,
    hasSocket: Boolean(g.sock),
    state: getConnectionState(),
    qr: await getQrSnapshot(),
    account: g.account,
    reconnectAttempts: g.reconnectAttempts,
    lastStatusCode: g.lastStatusCode,
  };
}

/** Uso interno de testes/diagnóstico. */
export function getSock(): WASocket | null {
  return getGlobal().sock;
}
