import { db } from "@/lib/db";
import { toWhatsAppDigits } from "@/lib/phone";
import { renderTemplate } from "./messages";
import { WhatsAppAdapterError, FRIENDLY_ERROR, type AdapterContext, type SendTarget } from "./adapter";
import { getAdapter, isMockEnabled, providerNameForOrg, canonicalProvider } from "./adapters";
import {
  backfillConversationsFromMessages,
  ensureConnectionRow,
  ensureConversationForTarget,
  ingestConnection,
  ingestMessage,
} from "./ingest";
import { logWa, redact } from "./logs";
import { publish } from "./bus";
import { toDbStatus, type AdapterSendResult, type AdapterStatus, type NormalizedMessage } from "./types";
import { assertSendAllowed, queueSendMessage } from "./queue";

/**
 * WhatsAppService — ponto de entrada único do módulo (§1, regra final do prompt).
 *
 * Toda rota, página e automação fala com este arquivo. Ele fala com um `WhatsAppAdapter`.
 * Ninguém mais importa Baileys. Isso é o que permite, um dia, trocar o adapter sem tocar no
 * resto do CRM — e é o que impede o caminho que existia antes: cada rota escolhia um
 * provedor por conta própria, e um provedor desconhecido caía num mock que respondia
 * "enviado" sem enviar nada.
 */

export type ConnectionView = {
  connectionId: string;
  provider: string;
  mock: boolean;
  /** Estado ao vivo do adapter. A UI confia neste, não em `savedStatus`. */
  state: AdapterStatus["state"];
  detail: string | null;
  /** Último estado gravado no banco (histórico/auditoria). */
  savedStatus: string;
  phone: string | null;
  accountName: string | null;
  lastSyncAt: Date | null;
  qr: string | null;
  qrAgeMs: number | null;
  unreadTotal: number;
  openConversations: number;
};

/** Contexto do adapter para a org, criando a linha de conexão se necessário. */
export async function adapterContext(orgId: string): Promise<AdapterContext> {
  const provider = await providerNameForOrg(orgId);
  const conn = await ensureConnectionRow(orgId, provider);
  return { orgId, connectionId: conn.id };
}

/**
 * Estado consolidado da conexão (§2): adapter ao vivo + espelho do banco + QR, numa chamada.
 * É o que a tela de Configurações e o cabeçalho do painel de conversas usam.
 */
async function retryRecentFailedConfirmations(orgId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const failed = await db.whatsAppMessage.findMany({
    where: {
      orgId,
      direction: "OUT",
      templateKey: "confirmation",
      status: "FAILED",
      createdAt: { gte: since },
    },
    select: { id: true },
    take: 20,
  });

  let retried = 0;
  for (const message of failed) {
    await db.whatsAppMessage.update({
      where: { id: message.id },
      data: { status: "QUEUED", error: null },
    });
    await queueSendMessage({ orgId, messageId: message.id, dedupeKey: `retry-confirmation:${message.id}` });
    retried++;
  }
  return retried;
}

export async function getConnectionView(orgId: string): Promise<ConnectionView> {
  const ctx = await adapterContext(orgId);
  const adapter = getAdapter(await providerNameForOrg(orgId));

  let live: AdapterStatus;
  try {
    live = await adapter.getStatus(ctx);
  } catch (err) {
    live = {
      state: "ERROR",
      detail: err instanceof WhatsAppAdapterError ? err.friendly ?? err.message : "Falha ao consultar o provedor.",
      provider: adapter.name,
      mock: adapter.mock,
    };
  }

  if (live.state === "CONNECTED") {
    void retryRecentFailedConfirmations(orgId).catch((err) => {
      console.error("[WhatsApp] Falha ao reativar confirmações pendentes:", err);
    });
  }

  // O adapter também é a fonte do QR: no Baileys ele já está em memória, sem tocar no disco.
  let qr: { qrCode: string | null; ageMs: number | null } = { qrCode: null, ageMs: null };
  if (live.state === "WAITING_QR" || live.state === "CONNECTING") {
    try {
      const snapshot = await adapter.getQr(ctx);
      qr = { qrCode: snapshot.qrCode, ageMs: snapshot.ageMs ?? null };
    } catch {
      /* QR indisponível não derruba o status */
    }
  }

  const [conn, aggregates] = await Promise.all([
    db.whatsAppConnection.findUnique({ where: { orgId } }),
    db.whatsAppConversation.aggregate({ where: { orgId, archived: false }, _sum: { unreadCount: true }, _count: true }),
  ]);

  return {
    connectionId: conn?.id ?? ctx.connectionId,
    provider: live.provider,
    mock: live.mock || isMockEnabled(),
    state: live.state,
    detail: redact(live.detail ?? null),
    savedStatus: conn?.status ?? "DISCONNECTED",
    phone: live.phone ?? conn?.phone ?? null,
    accountName: live.accountName ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    qr: qr.qrCode,
    qrAgeMs: qr.ageMs,
    unreadTotal: aggregates._sum.unreadCount ?? 0,
    openConversations: aggregates._count,
  };
}

/** Conecta (§2/§3). `freshQr=true` descarta a sessão salva e pede um QR novo com certeza. */
export async function connect(orgId: string, opts: { freshQr?: boolean } = {}): Promise<ConnectionView> {
  const ctx = await adapterContext(orgId);
  const provider = await providerNameForOrg(orgId);
  const adapter = getAdapter(provider);

  await logWa({ orgId, event: "connection.connect_requested", actor: provider, detail: opts.freshQr ? "QR novo" : "retomar sessão" });

  const status = await adapter.connect(ctx, { freshQr: opts.freshQr });

  // Persistimos o que o adapter devolveu — inclusive quando é WAITING_QR, para que um
  // restart do servidor não faça a tela "esquecer" que havia um QR pendente.
  await ingestConnection(orgId, {
    state: status.state,
    detail: status.detail,
    provider,
    jid: status.jid ?? null,
    lid: status.lid ?? null,
    phone: status.phone ?? null,
    accountName: status.accountName ?? null,
  });

  // Mock entrega eventos por callback; Bariels empurra direto para o ingest.
  if (adapter.attachEventHandler) {
    const { attachInboundHandler } = await import("./inbound-handler");
    attachInboundHandler(adapter, ctx);
  }

  return getConnectionView(orgId);
}

/** Desconecta: derruba o socket/instância e marca sessão como revogada (§2). */
export async function disconnect(orgId: string): Promise<ConnectionView> {
  const ctx = await adapterContext(orgId);
  const provider = await providerNameForOrg(orgId);
  const adapter = getAdapter(provider);

  await adapter.disconnect(ctx);
  await ingestConnection(orgId, { state: "DISCONNECTED", detail: "Desconectado pelo CRM.", provider });
  await logWa({ orgId, event: "connection.disconnect", actor: provider });

  return getConnectionView(orgId);
}

/** QR atual, com idade (§3). */
export async function currentQr(orgId: string) {
  const ctx = await adapterContext(orgId);
  const adapter = getAdapter(await providerNameForOrg(orgId));
  return adapter.getQr(ctx);
}

/**
 * Abre (ou retoma) uma conversa a partir de um número (§8): é o botão "Nova conversa" da
 * tela. Só escreve no nosso banco — nada aqui fala com o WhatsApp, então funciona igual no
 * modo mock e antes de a conexão existir.
 */
export async function openConversation(
  orgId: string,
  target: { phone?: string | null; jid?: string | null; name?: string | null; customerId?: string | null }
): Promise<{ ok: boolean; friendly?: string; conversationId?: string; contactId?: string; jid?: string; masked?: boolean }> {
  const digits = target.phone
    ? toWhatsAppDigits(target.phone)
    : target.jid && target.jid.endsWith("@s.whatsapp.net")
    ? target.jid.split("@")[0].split(":")[0].replace(/\D/g, "")
    : null;
  if (!target.jid && !digits) {
    return { ok: false, friendly: "Informe um número com DDI e DDD (ex.: 5531987707962)." };
  }

  const jid = target.jid?.trim() || `${digits}@s.whatsapp.net`;
  const { contact, conversation } = await ensureConversationForTarget({
    orgId,
    jid,
    phone: digits,
    name: target.name?.trim() || null,
    customerId: target.customerId ?? null,
  });

  await logWa({ orgId, event: "conversation.opened", actor: digits ?? contact.jid, status: conversation.id });
  publish({ type: "conversation.changed", orgId, conversationId: conversation.id });

  return {
    ok: true,
    conversationId: conversation.id,
    contactId: contact.id,
    jid: contact.jid,
    masked: contact.jid.endsWith("@lid"),
  };
}

/**
 * Provedor escolhido para esta barbearia (§29). Gravamos na linha de conexão — trocar de
 * provider é configuração, não código.
 */
export async function setProvider(orgId: string, provider: string) {
  const name = canonicalProvider(provider);
  if (name !== "BARIELS" && name !== "MOCK") {
    return {
      ok: false,
      friendly: `O provedor "${provider}" ainda não tem adapter neste projeto. Escolha Bariels (WhatsApp Web) ou simulado.`,
    };
  }
  const ctx = await adapterContext(orgId);
  await db.whatsAppConnection.update({ where: { id: ctx.connectionId }, data: { provider: name } });
  await logWa({ orgId, event: "connection.provider_changed", actor: name });
  return { ok: true, provider: name };
}

/**
 * Reconexão automática no boot (§18), agora com a regra que faltava:
 *
 * O socket do WhatsApp Web é UM por processo. Antes o worker percorria todas as conexões e
 * chamava `ensureConnected` em cada uma, que devolvia o estado GLOBAL — então a org B (sem
 * pareamento nenhum) aparecia "CONNECTED" e mandava mensagem pelo QR da org A. Aqui:
 *  - só tentamos reconectar quem tem sessão salva no disco;
 *  - paramos no primeiro sucesso (ou no primeiro QR pendente);
 *  - nunca marcamos uma org como conectada sem que o adapter tenha confirmado aquela org.
 */
export async function autoConnectWhatsApp(): Promise<{ orgId: string | null; state: AdapterStatus["state"] }> {
  if (isMockEnabled()) return { orgId: null, state: "DISCONNECTED" };

  const connections = await db.whatsAppConnection.findMany({ select: { orgId: true, provider: true }, take: 50 });
  const candidates = connections.filter((c) => {
    const name = canonicalProvider(c.provider);
    return name === "BARIELS";
  });

  for (const candidate of candidates) {
    const ctx = await adapterContext(candidate.orgId);
    const adapter = getAdapter("BARIELS");
    if (!(await adapter.hasStoredSession?.(ctx))) continue;

    try {
      const status = await adapter.connect(ctx);
      if (status.state === "CONNECTED") {
        await ingestConnection(candidate.orgId, {
          state: "CONNECTED",
          detail: status.detail,
          provider: "BARIELS",
          jid: status.jid ?? null,
          lid: status.lid ?? null,
          phone: status.phone ?? null,
          accountName: status.accountName ?? null,
        });
        console.log(`[WhatsApp] Sessão retomada para a org ${candidate.orgId}.`);
        return { orgId: candidate.orgId, state: "CONNECTED" };
      }
      // QR pendente = alguém precisa escanear. Insistir em outra org só expulsaria esta.
      if (status.state === "WAITING_QR") return { orgId: candidate.orgId, state: status.state };
    } catch (err) {
      await logWa({
        orgId: candidate.orgId,
        level: "error",
        event: "connection.auto",
        detail: err instanceof WhatsAppAdapterError ? err.message : String(err),
      });
    }
  }

  return { orgId: null, state: "DISCONNECTED" };
}

/**
 * Botão "Testar conexão" (§30), em itens verificáveis — não um checkmark decorativo.
 * Cada item mede uma coisa diferente: processo, sessão em disco, conta, tempo real.
 */
export async function testConnection(orgId: string): Promise<{ ok: boolean; items: { key: string; label: string; ok: boolean; detail: string | null }[] }> {
  const ctx = await adapterContext(orgId);
  const provider = await providerNameForOrg(orgId);
  const adapter = getAdapter(provider);

  const items: { key: string; label: string; ok: boolean; detail: string | null }[] = [];

  items.push({
    key: "api",
    label: "API acessível",
    ok: true,
    detail: adapter.mock ? "Modo simulado (WHATSAPP_MOCK=true)." : `Provedor ${adapter.name} carregado.`,
  });

  let status: AdapterStatus | null = null;
  try {
    status = await adapter.getStatus(ctx);
    items.push({ key: "auth", label: "Autenticação válida", ok: status.state !== "ERROR", detail: redact(status.detail) });
  } catch (err) {
    items.push({
      key: "auth",
      label: "Autenticação válida",
      ok: false,
      detail: err instanceof WhatsAppAdapterError ? err.friendly ?? err.message : redact(String(err)),
    });
  }

  const conn = await db.whatsAppConnection.findUnique({ where: { orgId } });
  items.push({
    key: "instance",
    label: "Instância encontrada",
    ok: Boolean(conn),
    detail: conn ? `Conexão ${conn.provider}` : "Nenhuma conexão gravada para esta clínica.",
  });

  items.push({
    key: "whatsapp",
    label: "WhatsApp conectado",
    ok: status?.state === "CONNECTED",
    detail: status ? `${status.state}${status.phone ? ` • ${status.phone}` : ""}` : null,
  });

  // Baileys/Web não usa webhook HTTP: o "tempo real" é o socket + barramento. Dizemos isso
  // em vez de mentir com um "webhook configurado ✓".
  items.push({
    key: "webhook",
    label: adapter.mock ? "Eventos simulados" : "Tempo real",
    ok: true,
    detail: "Este provedor entrega eventos pelo socket do WhatsApp Web (não usa webhook externo).",
  });

  const ok = items.every((i) => i.ok);
  await logWa({ orgId, event: "connection.test", actor: provider, status: ok ? "ok" : "fail", detail: items.filter((i) => !i.ok).map((i) => i.key).join(",") });
  return { ok, items };
}

/**
 * Variáveis de template (§7).
 * `{{nome}}` do contato, `{{empresa}}` do lead, `{{telefone}}`, `{{usuario}}` de quem envia.
 */
export async function buildVariables(opts: {
  orgId: string;
  customerId?: string | null;
  userId?: string | null;
  extra?: Record<string, string | number | null | undefined>;
}): Promise<Record<string, string>> {
  const [org, customer, user] = await Promise.all([
    db.organization.findUnique({ where: { id: opts.orgId }, select: { name: true } }),
    opts.customerId
      ? db.customer.findFirst({
          where: { id: opts.customerId, orgId: opts.orgId },
          select: { name: true, phone: true },
        })
      : null,
    opts.userId ? db.user.findUnique({ where: { id: opts.userId }, select: { name: true, email: true } }) : null,
  ]);

  const opportunity = opts.customerId
    ? await db.opportunity.findFirst({ where: { orgId: opts.orgId }, select: { title: true }, orderBy: { detectedAt: "desc" } })
    : null;

  return {
    nome: customer?.name ?? "",
    cliente: customer?.name ?? "",
    empresa: org?.name ?? "",
    barbearia: org?.name ?? "",
    telefone: customer?.phone ?? "",
    usuario: user?.name ?? user?.email ?? "",
    oportunidade: opportunity?.title ?? "",
    ...Object.fromEntries(Object.entries(opts.extra ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
  };
}

export type SendInput = {
  orgId: string;
  /** Número digitado/armazenado; o adapter resolve para jid e confere no servidor. */
  phone?: string | null;
  /** jid conhecido da conversa (tem precedência). */
  jid?: string | null;
  body: string;
  customerId?: string | null;
  appointmentId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  templateKey?: string | null;
  extra?: Record<string, string | number | null | undefined>;
  media?: { kind: "image" | "video" | "audio" | "document"; url: string; fileName?: string; mimeType?: string };
  /** true = manda agora (chat interativo); false = passa pela fila (§26). */
  immediate?: boolean;
  /**
   * Linha já gravada a ser enviada (caminho da fila): em vez de criar histórico novo,
   * atualizamos esta mensagem. Sem isso cada job de `send_whatsapp` duplicaria a mensagem.
   */
  messageId?: string | null;
};

export type SendOutcome = {
  ok: boolean;
  messageId: string;
  conversationId: string | null;
  status: string;
  error?: string;
  friendly?: string;
  queued?: boolean;
};

/**
 * Envia uma mensagem do CRM (§6/§7/§13).
 *
 * Ordem obrigatória: valida destino → garante conversa → grava QUEUED → adapter → aplica o
 * status REAL. Se o WhatsApp devolver só PENDING, é PENDING que aparece na tela; nunca
 * "enviada" por otimismo.
 */
export async function sendMessage(input: SendInput): Promise<SendOutcome> {
  const { orgId } = input;

  const vars = await buildVariables({ orgId, customerId: input.customerId, userId: input.userId, extra: input.extra });
  const body = renderTemplate(input.body, vars);
  if (!body.trim()) {
    return { ok: false, messageId: "", conversationId: null, status: "FAILED", error: "Mensagem vazia.", friendly: "Escreva uma mensagem antes de enviar." };
  }

  // Destino: jid conhecido, o jid do contato da própria mensagem, ou telefone → dígitos.
  const existing = input.messageId
    ? await db.whatsAppMessage.findFirst({ where: { id: input.messageId, orgId } })
    : null;

  // Reaproveitar uma linha existente é o caminho da fila (§26): o job já viu aquela
  // mensagem, e criar outra linha para o mesmo envio duplicaria o histórico na tela.
  if (existing && existing.status !== "QUEUED" && existing.status !== "FAILED") {
    return {
      ok: existing.status !== "CANCELLED",
      messageId: existing.id,
      conversationId: existing.conversationId,
      status: existing.status,
      error: existing.error ?? undefined,
    };
  }

  const storedContact = existing?.contactId
    ? await db.whatsAppContact.findFirst({
        where: { id: existing.contactId, orgId },
        select: { jid: true, phone: true, customerId: true },
      })
    : null;

  const knownJid = input.jid ?? (existing?.phone?.includes("@") ? existing.phone : null) ?? storedContact?.jid ?? null;
  const rawPhone = input.phone ?? (existing?.phone && !existing.phone.includes("@") ? existing.phone : null) ?? storedContact?.phone ?? null;
  const digits = rawPhone
    ? toWhatsAppDigits(rawPhone)
    : knownJid && knownJid.endsWith("@s.whatsapp.net")
    ? knownJid.split("@")[0].split(":")[0].replace(/\D/g, "")
    : null;
  if (!knownJid && !digits) {
    return {
      ok: false,
      messageId: existing?.id ?? "",
      conversationId: existing?.conversationId ?? null,
      status: "FAILED",
      error: "numero_invalido",
      friendly: "Esse número não é discável no WhatsApp. Confira DDI e DDD (ex.: 5531987707962).",
    };
  }

  const customerId = input.customerId ?? existing?.customerId ?? storedContact?.customerId ?? null;
  const guard = await assertSendAllowed({ orgId, phone: digits, customerId });
  if (!guard.ok) {
    if (existing) {
      await db.whatsAppMessage.update({ where: { id: existing.id }, data: { status: "CANCELLED", error: redact(guard.reason) } });
    }
    return {
      ok: false,
      messageId: existing?.id ?? "",
      conversationId: existing?.conversationId ?? null,
      status: "FAILED",
      error: guard.reason ?? "bloqueado",
      friendly: guard.reason ?? undefined,
    };
  }

  const jid = knownJid ?? `${digits}@s.whatsapp.net`;
  const { conn, contact, conversation } = await ensureConversationForTarget({
    orgId,
    jid,
    phone: digits,
    name: null,
    customerId,
  });

  const message =
    existing ??
    (await db.whatsAppMessage.create({
      data: {
        orgId,
        connectionId: conn.id,
        conversationId: input.conversationId ?? conversation.id,
        contactId: contact.id,
        customerId: contact.customerId,
        appointmentId: input.appointmentId ?? null,
        direction: "OUT",
        phone: digits ?? jid,
        body,
        messageType: input.media ? input.media.kind : "text",
        mediaUrl: input.media?.url ?? null,
        mediaMime: input.media?.mimeType ?? null,
        templateKey: input.templateKey ?? null,
        status: "QUEUED",
      },
    }));

  // Mensagem que veio da fila já tinha conversa? Então só confirmamos o vínculo, sem
  // duplicar histórico: é o eco do envio que atualiza a linha, não uma linha nova.
  if (existing && (!existing.conversationId || !existing.contactId)) {
    await db.whatsAppMessage.update({
      where: { id: existing.id },
      data: { conversationId: conversation.id, contactId: contact.id, customerId },
    });
  }

  publish({ type: "conversation.changed", orgId, conversationId: message.conversationId ?? conversation.id });

  if (input.immediate === false) {
    await queueSendMessage({ orgId, messageId: message.id });
    return { ok: true, messageId: message.id, conversationId: message.conversationId, status: "QUEUED", queued: true };
  }

  const ctx: AdapterContext = { orgId, connectionId: conn.id };
  const adapter = getAdapter(await providerNameForOrg(orgId));
  const target: SendTarget = { phone: digits, jid };

  let result: AdapterSendResult;
  try {
    result = input.media
      ? await adapter.sendMedia(ctx, target, {
          kind: input.media.kind,
          url: input.media.url,
          caption: body,
          fileName: input.media.fileName,
          mimeType: input.media.mimeType,
        })
      : await adapter.sendText(ctx, target, body);
  } catch (err) {
    const friendly = err instanceof WhatsAppAdapterError ? err.friendly ?? FRIENDLY_ERROR[err.code] : FRIENDLY_ERROR.UNKNOWN;
    await db.whatsAppMessage.update({ where: { id: message.id }, data: { status: "FAILED", error: redact(friendly) } });
    await logWa({ orgId, level: "error", event: "message.send_failed", actor: digits ?? jid, detail: friendly });
    return { ok: false, messageId: message.id, conversationId: message.conversationId, status: "FAILED", error: String(err), friendly };
  }

  const status = result.status ?? (result.ok ? "pending" : "failed");
  const dbStatus = toDbStatus(status);

  await db.whatsAppMessage.update({
    where: { id: message.id },
    data: {
      status: dbStatus as any,
      providerMsgId: result.providerMsgId ?? null,
      error: result.ok ? null : redact(result.error ?? "Falha no envio"),
      sentAt: result.ok && dbStatus !== "PENDING" ? new Date() : null,
    },
  });

  await db.whatsAppConversation.update({
    where: { id: message.conversationId ?? conversation.id },
    data: { lastBody: body.slice(0, 280), lastMessageAt: new Date() },
  });

  if (result.resolvedJid && result.resolvedJid !== contact.jid) {
    try {
      const existingWithResolved = await db.whatsAppContact.findUnique({
        where: { orgId_jid: { orgId, jid: result.resolvedJid } },
      });
      if (!existingWithResolved) {
        await db.whatsAppContact.update({
          where: { id: contact.id },
          data: { jid: result.resolvedJid },
        });
      } else if (existingWithResolved.id !== contact.id) {
        await db.whatsAppMessage.update({
          where: { id: message.id },
          data: { contactId: existingWithResolved.id },
        });
      }
    } catch (updateErr) {
      console.warn(`[WhatsAppService] Falha ao atualizar jid do contato ${contact.id}:`, updateErr);
    }
  }

  await logWa({
    orgId,
    level: result.ok ? "info" : "error",
    event: result.ok ? "message.sent" : "message.failed",
    actor: digits ?? jid,
    status: dbStatus,
    detail: result.error ?? null,
  });

  publish({ type: "dashboard.changed", orgId });
  publish({ type: "conversation.changed", orgId, conversationId: message.conversationId ?? conversation.id });

  return {
    ok: result.ok,
    messageId: message.id,
    conversationId: message.conversationId ?? conversation.id,
    status: dbStatus,
    error: result.error,
    friendly: result.ok ? undefined : redact(result.error ?? FRIENDLY_ERROR.NOT_CONNECTED) ?? undefined,
  };
}

/**
 * Entrega um evento de entrada vindo do adapter (caminho do mock, que não tem socket).
 * O Baileys já chama `ingestEvent` sozinho — aqui só entra quem usa callback.
 */
export async function deliverInboundEvent(orgId: string, message: NormalizedMessage) {
  return ingestMessage(orgId, message);
}

/**
 * Traz o histórico anterior ao módulo de conversas para a tela (§12). Idempotente e só de
 * leitura/ligação: nenhuma mensagem é criada, apagada ou reenviada.
 */
export async function backfillHistory(orgId: string) {
  const result = await backfillConversationsFromMessages(orgId);
  publish({ type: "dashboard.changed", orgId });
  publish({ type: "conversation.changed", orgId, conversationId: "" });
  return result;
}

/**
 * Reenvio (§7/§26): a MESMA linha volta para a fila — não cria uma segunda mensagem e não
 * fura as proteções. Passa de novo por pausa, limite por hora, lista de bloqueio e opt-out,
 * porque "reenviar" é um envio como qualquer outro.
 */
export async function resendMessage(orgId: string, messageId: string): Promise<SendOutcome> {
  const message = await db.whatsAppMessage.findFirst({ where: { id: messageId, orgId, direction: "OUT" } });
  if (!message) {
    return {
      ok: false,
      messageId,
      conversationId: null,
      status: "FAILED",
      error: "Mensagem não encontrada.",
      friendly: "Mensagem não encontrada.",
    };
  }
  if (["QUEUED", "PENDING", "SENT", "DELIVERED", "READ"].includes(message.status)) {
    return {
      ok: true,
      messageId,
      conversationId: message.conversationId,
      status: message.status,
      friendly: "Esta mensagem já está em envio ou já foi entregue.",
    };
  }

  await db.whatsAppMessage.update({
    where: { id: messageId },
    data: { status: "QUEUED", error: null, providerMsgId: null, sentAt: null },
  });
  await logWa({ orgId, event: "message.resend_requested", actor: message.phone, detail: messageId });

  return sendMessage({
    orgId,
    messageId,
    phone: message.phone,
    body: message.body,
    customerId: message.customerId,
    conversationId: message.conversationId,
    templateKey: message.templateKey ?? undefined,
    media:
      message.mediaUrl && ["image", "video", "audio", "document"].includes(message.messageType)
        ? {
            kind: message.messageType as "image" | "video" | "audio" | "document",
            url: message.mediaUrl,
            mimeType: message.mediaMime ?? undefined,
          }
        : undefined,
    immediate: false,
  });
}

/** Indicadores do painel (§20). */export async function connectionMetrics(orgId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [received, sent, conversationsToday, failed, pending, answeredCustomers, contactedCustomers, waitingReply] =
    await Promise.all([
      db.whatsAppMessage.count({ where: { orgId, direction: "IN", createdAt: { gte: startOfDay } } }),
      db.whatsAppMessage.count({ where: { orgId, direction: "OUT", createdAt: { gte: startOfDay } } }),
      db.whatsAppConversation.count({ where: { orgId, lastMessageAt: { gte: startOfDay } } }),
      db.whatsAppMessage.count({ where: { orgId, status: "FAILED" } }),
      db.whatsAppMessage.count({ where: { orgId, status: { in: ["QUEUED", "PENDING"] } } }),
      db.whatsAppMessage.findMany({
        where: { orgId, direction: "IN", createdAt: { gte: startOfDay } },
        distinct: ["customerId"],
        select: { customerId: true },
      }),
      db.whatsAppMessage.findMany({
        where: { orgId, direction: "OUT", createdAt: { gte: startOfDay }, customerId: { not: null } },
        distinct: ["customerId"],
        select: { customerId: true },
      }),
      db.whatsAppConversation.count({ where: { orgId, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    ]);

  return {
    receivedToday: received,
    sentToday: sent,
    conversationsToday,
    failed,
    pending,
    // Só conta quem tem cliente vinculado: número mascarado (@lid) não é lead identificável.
    answeredToday: answeredCustomers.filter((c) => c.customerId).length,
    contactedToday: contactedCustomers.length,
    openConversations: waitingReply,
  };
}
