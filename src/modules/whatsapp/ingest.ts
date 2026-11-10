import { db, type PrismaClientOrTx } from "@/lib/db";
import { whatsappPhoneVariants } from "@/lib/phone";
import { sendTemplateMessage } from "./messages";
import {
  canAdvanceStatus,
  toDbDirection,
  toDbStatus,
  type ConnectionState,
  type DeliveryStatus,
  type NormalizedEvent,
  type NormalizedMessage,
} from "./types";
import { logWa, redact } from "./logs";
import { publish } from "./bus";

/**
 * Escritor único do que chega do WhatsApp (§12, §13).
 *
 * Antes, cada caminho (eco, mensagem nova, recibo) dava seu próprio `db.whatsAppMessage`
 * write dentro do arquivo do Baileys. Resultado: histórico sem conversa, contato sem
 * vínculo com o CRM e status que só existia numa tabela. Aqui entra o evento já
 * normalizado pelo adapter e sai: conta, contato, conversa, mensagem, mídia e o evento
 * publicado no barramento para as telas abertas.
 *
 * Nada neste arquivo conhece Baileys/Evolution/API: quem converte o formato cru é o
 * adapter (§16). Trocar de provider não muda uma linha daqui.
 */

/** Garante a linha WhatsAppConnection da org e devolve o id. Provider nunca é "DEV" por padrão. */
export async function ensureConnectionRow(orgId: string, provider: string) {
  const conn = await db.whatsAppConnection.upsert({
    where: { orgId },
    update: {}, // não sobrescrevemos status/provider aqui: quem manda no estado é o adapter
    create: { orgId, provider: provider.toUpperCase(), status: "DISCONNECTED" },
  });
  return conn;
}

/**
 * `find` e depois `create` é uma corrida que o SQLite local escondeu e o Postgres remoto revelou.
 *
 * Cada ida ao pooler leva ~200 ms. Duas mensagens da mesma pessoa — tipicamente a OUT que o
 * painel acabou de gravar e o eco que volta pelo Baileys — entram aqui quase juntas, as duas
 * leem `null`, e a segunda apanha
 * `prisma:error … Unique constraint failed on the fields: (orgId,jid)` (o P2002 do Postgres;
 * no SQLite as escritas eram rápidas demais para se sobrepor). A linha que causou o conflito é
 * exatamente a que queríamos ter: reler uma vez e seguir pelo caminho de update resolve, sem
 * transação nova e sem mudar nada do que a tela mostra.
 */
async function comRetrySeDuplicato<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    return await fn();
  }
}

/**
 * JIDs de número (`@s.whatsapp.net`) que podem pertencer à MESMA pessoa: o que chegou, o que
 * o `remoteJidAlt` trouxe e as variações de DDI/9º dígito que o banco já guarda (`whatsappPhoneVariants`).
 */
function pnJidVariants(...jids: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const jid of jids) {
    if (!jid?.endsWith("@s.whatsapp.net")) continue;
    const local = jid.split("@")[0].split(":")[0];
    for (const variant of whatsappPhoneVariants(local)) out.add(`${variant}@s.whatsapp.net`);
  }
  return [...out];
}

/** Identidade de uma mensagem: o JID que chegou, o JID do outro domínio e o telefone derivados. */
type Identity = { jid: string; altJid?: string | null; phone?: string | null };

/**
 * Acha o contato que representa ESTA PESSOA, não o JID literal.
 *
 * Desde a migração para usernames o WhatsApp endereça a mesma conta de dois jeitos:
 * `55...@s.whatsapp.net` (número) e `<id>@lid` (identidade mascarada). Comparar só o JID cru
 * criava um segundo contato — e portanto uma segunda conversa — para o mesmo cliente, que é
 * exatamente o que a tela do WhatsApp mostrava quando o cliente respondia.
 *
 * Ordem de resolução: NÚMERO primeiro (jid pn → variações → telefone gravado), porque é a
 * identidade que o CRM e o envio usam; só depois o `@lid`. Assim, uma resposta que chega
 * endereçada por @lid — e cujo `remoteJidAlt` revelou o número — entra na conversa que já
 * existe pelo telefone, em vez de abrir a segunda janela.
 */
async function findContactByIdentity(orgId: string, id: Identity) {
  const { jid, altJid = null, phone = null } = id;

  for (const candidate of pnJidVariants(jid, altJid)) {
    const byJid = await db.whatsAppContact.findUnique({ where: { orgId_jid: { orgId, jid: candidate } } });
    if (byJid) return byJid;
  }

  if (phone) {
    const variants = whatsappPhoneVariants(phone);
    if (variants.length) {
      const byPhone = await db.whatsAppContact.findFirst({
        where: { orgId, phone: { in: variants } },
        orderBy: { lastSeenAt: "desc" },
      });
      if (byPhone) return byPhone;
    }
  }

  // Chega aqui só quem NÃO tem número conhecido: contato mascarado por @lid.
  const exact = await db.whatsAppContact.findUnique({ where: { orgId_jid: { orgId, jid } } });
  if (exact) return exact;

  if (jid.endsWith("@lid")) {
    const byLid = await db.whatsAppContact.findFirst({
      where: { orgId, lid: jid },
      orderBy: { lastSeenAt: "desc" },
    });
    if (byLid) return byLid;
  }

  return null;
}

/**
 * Junta a linha "à parte" que o @lid tinha criado com o contato canônico, quando a mesma
 * pessoa aparece nas duas. Roda no caminho de escrita para o chat dividir não sobreviver à
 * próxima mensagem — é a mesclagem do histórico acontecendo sozinha, na hora.
 *
 * Falhou? Só loga: perder uma mensagem é pior do que deixar duas janelas abertas para o
 * atendente resolver. O script `merge-duplicate-conversations.ts` cobre o resto.
 */
async function absorbStrayContact(orgId: string, strayId: string, canonicalId: string) {
  try {
    await db.$transaction(async (tx) => {
      const canonicalConv = await tx.whatsAppConversation.findUnique({
        where: { orgId_contactId: { orgId, contactId: canonicalId } },
        select: { id: true },
      });
      const strayConv = await tx.whatsAppConversation.findUnique({
        where: { orgId_contactId: { orgId, contactId: strayId } },
        select: { id: true },
      });

      if (strayConv && canonicalConv) {
        const strayLabels = await tx.whatsAppConversationLabel.findMany({
          where: { conversationId: strayConv.id },
          select: { labelId: true },
        });
        const canonicalLabels = await tx.whatsAppConversationLabel.findMany({
          where: { conversationId: canonicalConv.id },
          select: { labelId: true },
        });
        const already = new Set(canonicalLabels.map((l) => l.labelId));
        const missing = strayLabels.map((l) => l.labelId).filter((id) => !already.has(id));
        // createMany+skipDuplicates tem comportamento diferente no SQLite do projeto; com
        // poucas etiquetas por conversa, o laço explícito é mais previsível que a bandeira.
        for (const labelId of missing) {
          await tx.whatsAppConversationLabel.create({ data: { conversationId: canonicalConv.id, labelId } });
        }
        await tx.whatsAppFollowUp.updateMany({
          where: { conversationId: strayConv.id },
          data: { conversationId: canonicalConv.id },
        });
        await tx.whatsAppMessage.updateMany({
          where: { conversationId: strayConv.id },
          data: { conversationId: canonicalConv.id, contactId: canonicalId },
        });
        await tx.whatsAppConversation.delete({ where: { id: strayConv.id } });
      }

      // Sem conversa canônica: a conversa órfã muda de dono e continua no mesmo lugar da tela.
      if (strayConv && !canonicalConv) {
        await tx.whatsAppConversation.update({ where: { id: strayConv.id }, data: { contactId: canonicalId } });
      }

      await tx.whatsAppMessage.updateMany({ where: { contactId: strayId }, data: { contactId: canonicalId } });

      const stray = await tx.whatsAppContact.findUnique({
        where: { id: strayId },
        select: { lid: true, jid: true },
      });
      const lidToCarry = stray?.lid ?? (stray?.jid.endsWith("@lid") ? stray.jid : null);
      if (lidToCarry) {
        const canonical = await tx.whatsAppContact.findUnique({
          where: { id: canonicalId },
          select: { lid: true },
        });
        if (!canonical?.lid) {
          await tx.whatsAppContact.update({ where: { id: canonicalId }, data: { lid: lidToCarry } });
        }
      }
      await tx.whatsAppContact.delete({ where: { id: strayId } });
    });
    logWa({ orgId, level: "info", event: "contact.merged", detail: `linha @lid absorvida pelo contato por telefone` });
  } catch (err) {
    console.error("[ingest] não foi possível mesclar o contato duplicado", redact(String(err)));
  }
}

/**
 * Contato do WhatsApp + vínculo com o CRM.
 *
 * `masked=true` (jid @lid) é o caso em que o WhatsApp esconde o número: aqueles dígitos
 * NÃO são telefone, então não criamos Customer com eles — só registramos o contato e a
 * tela oferece o preenchimento manual.
 */
async function tentarUpsertContact(opts: {
  orgId: string;
  connectionId: string;
  accountId?: string | null;
  message: NormalizedMessage;
}) {
  const { orgId, connectionId, accountId, message } = opts;

  // O telefone pode vir do remoteJidAlt mesmo quando a conversa está endereçada por @lid.
  const identity: Identity = {
    jid: message.jid,
    altJid: message.altJid ?? null,
    phone: message.phone ?? null,
  };
  const existing = await findContactByIdentity(orgId, identity);

  // Uma linha EXATAMENTE deste JID pode existir e ser outra pessoa? Não — se existe, é o
  // registro @lid que a pessoa tinha antes de sabermos o telefone dela. Nesse caso ele é a
  // duplicata que acabamos de resolver, e a mesclagem imediata evita a segunda janela na tela.
  const stray =
    existing && existing.jid !== message.jid
      ? await db.whatsAppContact.findUnique({
          where: { orgId_jid: { orgId, jid: message.jid } },
          select: { id: true },
        })
      : null;

  let customerId = existing?.customerId ?? null;
  if (!customerId && message.phone) {
    const customer = await db.customer.findFirst({
      where: { orgId, phone: message.phone },
      select: { id: true },
    });
    customerId = customer?.id ?? null;
  }

  const name = message.pushName?.trim() || existing?.name || null;
  // "masked" no contato quer dizer "não sabemos o número desta pessoa", e não "o último
  // JID era @lid": se o remoteJidAlt revelou o telefone, ou se ele já estava gravado, a
  // identidade é conhecida e a tela pode tratar isso como cliente normal.
  const knownPhone = message.phone ?? existing?.phone ?? null;
  const masked = !knownPhone;
  const lidSeen = message.jid.endsWith("@lid") ? message.jid : null;

  /**
   * `jid` é o endereço com que a gente ENVIA; por isso um contato que já tem número nunca
   * regrava o próprio jid com o @lid que chegou (faria o envio parar de funcionar e ainda
   * colidiria com a unique `orgId_jid` da linha @lid). O @lid vai para o campo `lid`.
   * Na direção contrária vale promover: se só tínhamos o @lid e agora chegou o número,
   * o contato passa a ser discável.
   */
  const nextJid = (current: string) => {
    if (current.endsWith("@s.whatsapp.net")) return current;
    return message.jid.endsWith("@s.whatsapp.net") ? message.jid : current;
  };

  const contact = existing
    ? await db.whatsAppContact.update({
        where: { id: existing.id },
        data: {
          jid: nextJid(existing.jid),
          name,
          phone: knownPhone,
          masked,
          lid: lidSeen ?? existing.lid ?? null,
          customerId,
          connectionId,
          accountId: accountId ?? existing.accountId ?? null,
          lastSeenAt: new Date(),
        },
      })
    : await db.whatsAppContact.create({
        data: {
          orgId,
          jid: message.jid,
          lid: lidSeen,
          phone: knownPhone,
          masked,
          name,
          customerId,
          connectionId,
          accountId: accountId ?? null,
          source: "whatsapp",
          lastSeenAt: new Date(),
        },
      });

  if (stray && stray.id !== contact.id) await absorbStrayContact(orgId, stray.id, contact.id);

  return { contact, customerId };
}

/** `tentarUpsertContact` com a segunda leitura de que o Postgres remoto precisa. */
async function upsertContact(opts: Parameters<typeof tentarUpsertContact>[0]) {
  return comRetrySeDuplicato(() => tentarUpsertContact(opts));
}

/**
 * Customer (cadastro do CRM) criado a partir de um número real que mandou mensagem.
 * Mantém o comportamento que já existia — barbeiro precisa do cliente no cadastro para
 * agendar — e é por isso que só rodamos com `masked=false` e telefone confirmado.
 */
async function ensureCustomer(opts: { orgId: string; message: NormalizedMessage; name: string | null }) {
  const { orgId, message } = opts;
  if (message.masked || !message.phone) return null;

  const found = await db.customer.findFirst({ where: { orgId, phone: message.phone }, select: { id: true } });
  if (found) return found.id;

  try {
    const created = await db.customer.create({
      data: {
        orgId,
        name: opts.name ?? `Cliente ${message.phone.slice(-4)}`,
        phone: message.phone,
        // Consentimento: o cliente falou primeiro, então o canal está liberado (§25).
        whatsappOptIn: true,
      },
    });
    return created.id;
  } catch (err) {
    // Outra mensagem do mesmo número criou a ficha entre a nossa leitura e a nossa escrita
    // (`@@unique([orgId, phone])`): a linha que já está lá é exatamente a que queríamos.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const criadaPorOutra = await db.customer.findFirst({
      where: { orgId, phone: message.phone },
      select: { id: true },
    });
    if (!criadaPorOutra) throw err;
    return criadaPorOutra.id;
  }
}

async function tentarUpsertConversation(opts: {
  orgId: string;
  connectionId: string;
  accountId?: string | null;
  contactId: string;
  customerId: string | null;
  message: NormalizedMessage;
  incrementUnread: boolean;
}) {
  const { orgId, contactId, message } = opts;
  const when = message.timestampSec ? new Date(message.timestampSec * 1000) : new Date();
  const preview = `${message.messageType === "text" ? "" : `[${message.messageType}] `}${message.text}`.slice(0, 280);

  const existing = await db.whatsAppConversation.findUnique({
    where: { orgId_contactId: { orgId, contactId } },
  });

  if (existing) {
    const updated = await db.whatsAppConversation.update({
      where: { id: existing.id },
      data: {
        lastBody: preview,
        lastMessageAt: when,
        unreadCount: opts.incrementUnread ? existing.unreadCount + 1 : existing.unreadCount,
        customerId: existing.customerId ?? opts.customerId ?? null,
        connectionId: opts.connectionId,
        accountId: opts.accountId ?? existing.accountId ?? null,
      },
    });
    return updated;
  }

  return db.whatsAppConversation.create({
    data: {
      orgId,
      connectionId: opts.connectionId,
      accountId: opts.accountId ?? null,
      contactId,
      customerId: opts.customerId,
      status: "OPEN",
      unreadCount: opts.incrementUnread ? 1 : 0,
      lastBody: preview,
      lastMessageAt: when,
    },
  });
}

/** `tentarUpsertConversation` com a releitura que fecha a corrida do `(orgId,contactId)`. */
async function upsertConversation(opts: Parameters<typeof tentarUpsertConversation>[0]) {
  return comRetrySeDuplicato(() => tentarUpsertConversation(opts));
}

/**
 * Garante contato + conversa para um alvo ANTES do envio.
 *
 * Precisamos disso porque a mensagem OUT entra no banco como QUEUED (para aparecer na tela e
 * sobreviver a um restart) e o `providerMsgId` real só existe depois que o WhatsApp aceita.
 * Sem conversa criada antes, o eco que chega algum tempo depois abriria uma conversa nova e o
 * histórico ficaria dividido ao meio.
 */
export async function tentarEnsureConversationForTarget(opts: {
  orgId: string;
  jid: string;
  phone?: string | null;
  name?: string | null;
  customerId?: string | null;
}) {
  const { orgId, jid } = opts;
  const conn = await ensureConnectionRow(orgId, process.env.WHATSAPP_PROVIDER ?? "bariels");
  const accountId = await db.whatsAppAccount.findFirst({
    where: { orgId, connectionId: conn.id },
    select: { id: true },
  });

  // "mascarado" = não sabemos o número desta pessoa. Um jid @lid sozinho não basta para
  // marcar isso: se o alvo tem telefone (ou o contato já tem), a ficha é discável normal.
  const lidSeen = jid.endsWith("@lid") ? jid : null;
  const knownPhone = opts.phone ?? null;
  const masked = !knownPhone;
  // Mesma resolução do lado do recebimento: sem isso, o envio pelo painel achava o contato
  // pelo JID cru e criava uma segunda ficha (e segunda conversa) para o mesmo cliente.
  const existing = await findContactByIdentity(orgId, { jid, phone: opts.phone ?? null });

  let customerId = opts.customerId ?? existing?.customerId ?? null;
  if (!customerId && opts.phone) {
    const customer = await db.customer.findFirst({ where: { orgId, phone: opts.phone }, select: { id: true } });
    customerId = customer?.id ?? null;
  }

  const contact = existing
    ? await db.whatsAppContact.update({
        where: { id: existing.id },
        data: {
          name: opts.name ?? existing.name ?? null,
          phone: opts.phone ?? existing.phone ?? null,
          // Um contato que já tem número discável não é rebaixado para o @lid que chegou;
          // o @lid vai para o campo próprio, que é o gancho do findContactByIdentity.
          jid: existing.jid.endsWith("@s.whatsapp.net") || !jid.endsWith("@s.whatsapp.net")
            ? existing.jid
            : jid,
          // Guardar o @lid quando ele é conhecido evita que a próxima mensagem mascarada
          // vire outra ficha — é o gancho que o findContactByIdentity usa.
          lid: lidSeen ?? existing.lid ?? null,
          masked: (opts.phone ?? existing.phone ?? null) === null,
          customerId,
          connectionId: conn.id,
          lastSeenAt: new Date(),
        },
      })
    : await db.whatsAppContact.create({
        data: {
          orgId,
          jid,
          lid: lidSeen,
          phone: opts.phone ?? null,
          masked,
          name: opts.name ?? null,
          customerId,
          connectionId: conn.id,
          accountId: accountId?.id ?? null,
          source: opts.customerId ? "crm" : "manual",
          lastSeenAt: new Date(),
        },
      });

  const conversation = await db.whatsAppConversation.upsert({
    where: { orgId_contactId: { orgId, contactId: contact.id } },
    update: { customerId: contact.customerId },
    create: {
      orgId,
      connectionId: conn.id,
      accountId: accountId?.id ?? null,
      contactId: contact.id,
      customerId: contact.customerId,
      status: "OPEN",
      lastMessageAt: new Date(),
    },
  });

  return { conn, contact, conversation };
}

/** Mesma garantia, com a segunda tentativa quando outra escrita criou a linha primeiro. */
export async function ensureConversationForTarget(opts: Parameters<typeof tentarEnsureConversationForTarget>[0]) {
  return comRetrySeDuplicato(() => tentarEnsureConversationForTarget(opts));
}

/**
 * Reaproveita o histórico que existia antes do módulo de conversas (§12).
 *
 * As mensagens antigas foram gravadas com `phone` e `conversationId: null` — o painel de
 * conversas não tinha nascido. Em vez de deixar esse histórico fora da tela (ou escrever
 * um histórico paralelo), criamos contato + conversa a partir do número já gravado e
 * ligamos cada mensagem. É idempotente: só olha linha sem conversa e usa os mesmos upserts.
 */
export async function backfillConversationsFromMessages(orgId: string) {
  const orphans = await db.whatsAppMessage.findMany({
    where: { orgId, conversationId: null },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  let linked = 0;
  const skipped: { id: string; reason: string }[] = [];

  for (const msg of orphans) {
    const raw = String(msg.phone ?? "");
    const digits = raw.replace(/\D/g, "");
    // jid já salvo (ex.: 55...@s.whatsapp.net ou ...@lid) manda; senão montamos pelo número.
    const jid = raw.includes("@") ? raw : digits.length >= 10 ? `${digits}@s.whatsapp.net` : null;
    if (!jid) {
      skipped.push({ id: msg.id, reason: "sem número discável na mensagem" });
      continue;
    }
    // Os dígitos de um @lid NÃO são telefone: são a identidade interna do WhatsApp. Sem esse
    // filtro, o backfill inventaria um número para cada contato mascarado.
    const phone = jid.endsWith("@s.whatsapp.net") ? digits : null;

    const { contact, conversation } = await ensureConversationForTarget({
      orgId,
      jid,
      phone,
      customerId: msg.customerId ?? null,
    });

    await db.whatsAppMessage.update({
      where: { id: msg.id },
      data: {
        conversationId: conversation.id,
        contactId: contact.id,
        // O vínculo do CRM vem do contato quando a mensagem não tinha customerId.
        customerId: msg.customerId ?? contact.customerId ?? null,
      },
    });
    linked += 1;
  }

  // A prévia da lista (lastBody/lastMessageAt) vem das mensagens, não do contrário.
  const conversations = await db.whatsAppConversation.findMany({
    where: { orgId },
    select: { id: true, lastMessageAt: true },
  });
  for (const conv of conversations) {
    const last = await db.whatsAppMessage.findFirst({
      where: { conversationId: conv.id, orgId },
      orderBy: { createdAt: "desc" },
      select: { body: true, createdAt: true },
    });
    if (!last) continue;
    if (conv.lastMessageAt.getTime() === last.createdAt.getTime()) continue;
    await db.whatsAppConversation.update({
      where: { id: conv.id },
      data: { lastBody: last.body.slice(0, 280), lastMessageAt: last.createdAt },
    });
  }

  await logWa({
    orgId,
    event: "history.backfilled",
    status: `ok:${linked}`,
    detail: skipped.length ? `ignoradas: ${skipped.map((s) => s.reason).join(", ")}` : null,
  });

  return { scanned: orphans.length, linked, skipped };
}

/**
 * Aplica um status de entrega SEMPRE monotônico (§13).
 * O WhatsApp entrega recibos fora de ordem (o read pode chegar antes do delivery) e
 * reemite eventos duplicados; `canAdvanceStatus` é o que impede uma mensagem lida de
 * voltar para "enviada" na tela.
 */
export async function applyMessageStatus(opts: {
  orgId: string;
  messageId?: string;
  providerMsgId?: string;
  status: DeliveryStatus | "queued" | "received" | "cancelled";
  detail?: string | null;
}) {
  const { orgId, status } = opts;
  const dbStatus = toDbStatus(status);

  const message = opts.messageId
    ? await db.whatsAppMessage.findFirst({ where: { id: opts.messageId, orgId } })
    : opts.providerMsgId
      ? await db.whatsAppMessage.findFirst({ where: { orgId, providerMsgId: opts.providerMsgId } })
      : null;

  if (!message) return null;
  if (!canAdvanceStatus(message.status, dbStatus)) return message;

  const data: Record<string, unknown> = { status: dbStatus };
  const now = new Date();
  if (dbStatus === "SENT" && !message.sentAt) data.sentAt = now;
  if (dbStatus === "DELIVERED") data.deliveredAt = now;
  if (dbStatus === "READ") data.readAt = now;
  if (dbStatus === "FAILED") {
    data.error = redact(opts.detail, 300) ?? "WhatsApp recusou a mensagem";
  }

  const updated = await db.whatsAppMessage.update({ where: { id: message.id }, data: data as any });

  publish({
    type: "message.status",
    orgId,
    providerMsgId: updated.providerMsgId ?? "",
    jid: undefined,
    status: status as DeliveryStatus,
    detail: opts.detail ?? undefined,
  });
  publish({ type: "conversation.changed", orgId, conversationId: updated.conversationId ?? "" });

  return updated;
}

/** Persiste uma mensagem normalizada (entrada ou eco de saída) e atualiza a conversa. */
export async function ingestMessage(orgId: string, message: NormalizedMessage, tx?: PrismaClientOrTx) {
  const conn = await ensureConnectionRow(orgId, process.env.WHATSAPP_PROVIDER ?? "bariels");

  const accountId = await db.whatsAppAccount.findFirst({
    where: { orgId, connectionId: conn.id },
    select: { id: true },
  });

  const { contact, customerId } = await upsertContact({
    orgId,
    connectionId: conn.id,
    accountId: accountId?.id,
    message,
  });

  // Link com o CRM pode nascer depois: contato mascarado que um dia ganhou telefone.
  let linked = customerId;
  if (!linked && !message.masked && message.phone) {
    linked = (await ensureCustomer({ orgId, message, name: message.pushName ?? contact.name })) ?? null;
    if (linked && !contact.customerId) {
      await db.whatsAppContact.update({ where: { id: contact.id }, data: { customerId: linked } });
    }
  }

  const conversation = await upsertConversation({
    orgId,
    connectionId: conn.id,
    accountId: accountId?.id,
    contactId: contact.id,
    customerId: linked,
    message,
    incrementUnread: message.direction === "incoming",
  });

  // Idempotência (§33): o WhatsApp reenvia a mesma mensagem como notificação offline, e o
  // eco do que nós mesmos mandamos chega por messages.upsert depois do nosso INSERT.
  const duplicate = await db.whatsAppMessage.findFirst({
    where: { orgId, providerMsgId: message.providerMsgId },
  });

  if (duplicate) {
    if (!duplicate.conversationId) {
      await db.whatsAppMessage.update({
        where: { id: duplicate.id },
        data: { conversationId: conversation.id, contactId: contact.id },
      });
    }
    return { message: duplicate, conversation, contact, created: false };
  }

  const dbStatus = message.direction === "incoming" ? "RECEIVED" : "SENT";
  const created = await db.whatsAppMessage.create({
    data: {
      orgId,
      connectionId: conn.id,
      conversationId: conversation.id,
      contactId: contact.id,
      customerId: linked,
      direction: toDbDirection(message.direction),
      phone: message.phone ?? message.jid,
      body: message.text,
      messageType: message.messageType,
      mediaUrl: message.media?.url ?? null,
      mediaMime: message.media?.mimeType ?? null,
      status: dbStatus,
      providerMsgId: message.providerMsgId,
      sentAt: message.direction === "outgoing" ? new Date() : null,
    },
  });

  if (message.media) {
    await db.whatsAppMedia.create({
      data: {
        orgId,
        messageId: created.id,
        kind: message.media.kind,
        url: message.media.url ?? null,
        mimeType: message.media.mimeType ?? null,
        fileName: message.media.fileName ?? null,
        sizeBytes: message.media.sizeBytes ?? null,
      },
    });
  }

  publish({ type: "message.upsert", orgId, message });
  publish({ type: "conversation.changed", orgId, conversationId: conversation.id });
  publish({ type: "dashboard.changed", orgId });

  // Se o cliente respondeu "SIM" a um lembrete pendente, confirma a presença e manda
  // a confirmação com data/hora (§ respostas do cliente).
  if (message.direction === "incoming" && message.text) {
    const trimmed = message.text.trim().toUpperCase();
    if (trimmed === "SIM" || trimmed === "SIM.") {
      // READ entra na lista: o cliente precisa abrir a conversa para digitar, e o recibo
      // de leitura chega antes do "sim" — sem ele o lembrete some da busca e nada é enviado.
      const reminderWhere = {
        orgId,
        templateKey: { in: ["reminder_24h", "reminder_2h"] },
        status: { in: ["QUEUED", "SENT", "DELIVERED", "READ"] },
      };
      const pendingReminder =
        (await db.whatsAppMessage.findFirst({
          where: { ...reminderWhere, customerId: linked },
          orderBy: { createdAt: "desc" },
        })) ??
        // Reserva: o vínculo contato→Customer pode faltar (telefone gravado em outro
        // formato); a conversa em que o cliente respondeu identifica o lembrete do mesmo jeito.
        (await db.whatsAppMessage.findFirst({
          where: { ...reminderWhere, conversationId: conversation.id },
          orderBy: { createdAt: "desc" },
        }));

      if (pendingReminder?.appointmentId) {
        const appt = await db.appointment.findFirst({
          where: { id: pendingReminder.appointmentId, orgId },
          include: { customer: true, service: true, barber: true },
        });

        if (appt) {
          if (appt.status === "SCHEDULED") {
            try {
              const { changeStatus } = await import("@/modules/scheduling/appointments");
              await changeStatus({
                orgId,
                appointmentId: appt.id,
                to: "CONFIRMED",
                reason: "Cliente respondeu SIM ao lembrete no WhatsApp.",
              });
            } catch (err) {
              console.error("[ingest] Erro ao confirmar agendamento por SIM:", err);
            }
          }

          // A resposta SIM é o pedido explícito da confirmação: quem agenda para outro dia
          // recebe só o lembrete de 24h, então é aqui que chega o texto "Seu horário está
          // confirmado…" com {{data}} e {{hora}}. `sendTemplateMessage` já limita a UMA
          // confirmação por agendamento — quem recebeu no mesmo dia não recebe de novo.
          if (
            ["SCHEDULED", "CONFIRMED"].includes(appt.status) &&
            appt.customer.phone &&
            appt.customer.whatsappOptIn !== false
          ) {
            try {
              await sendTemplateMessage({
                orgId,
                templateKey: "confirmation",
                vars: {
                  appointmentId: appt.id,
                  customerId: appt.customerId,
                  phone: appt.customer.phone,
                  customerName: appt.customer.name,
                  serviceName: appt.service.name,
                  barberName: appt.barber.name,
                  startAt: appt.startAt,
                },
                dedupeKey: `confirmation:sim:${appt.id}`,
              });
            } catch (err) {
              console.error("[ingest] Erro ao enviar confirmação por SIM:", err);
            }
          }
        }
      }
    }
  }

  return { message: created, conversation, contact, created: true };
}

/** Traduz o estado canônico do adapter para o vocabulário gravado em WhatsAppConnection. */
export function toDbConnectionStatus(state: ConnectionState): string {
  switch (state) {
    case "CONNECTED":
      return "CONNECTED";
    case "WAITING_QR":
    case "CONNECTING":
      return "PENDING_QR";
    case "RECONNECT_REQUIRED":
      return "RECONNECT_REQUIRED";
    case "ERROR":
      return "ERROR";
    default:
      return "DISCONNECTED";
  }
}

/** Conta pareada + sessão administrativa + estado persistido (§2, §12). */
export async function ingestConnection(
  orgId: string,
  opts: {
    state: ConnectionState;
    detail?: string;
    provider: string;
    jid?: string | null;
    lid?: string | null;
    phone?: string | null;
    accountName?: string | null;
    avatarUrl?: string | null;
  }
) {
  const conn = await ensureConnectionRow(orgId, opts.provider);
  const dbStatus = toDbConnectionStatus(opts.state);
  const now = new Date();

  if (opts.state === "CONNECTED" && opts.jid) {
    await db.whatsAppAccount.upsert({
      where: { orgId_jid: { orgId, jid: opts.jid } },
      update: {
        status: "CONNECTED",
        lid: opts.lid ?? undefined,
        phone: opts.phone ?? undefined,
        accountName: opts.accountName ?? undefined,
        avatarUrl: opts.avatarUrl ?? undefined,
        lastSeenAt: now,
      },
      create: {
        orgId,
        connectionId: conn.id,
        provider: opts.provider.toUpperCase(),
        jid: opts.jid,
        lid: opts.lid ?? null,
        phone: opts.phone ?? null,
        accountName: opts.accountName ?? null,
        avatarUrl: opts.avatarUrl ?? null,
        status: "CONNECTED",
        pairedAt: now,
        lastSeenAt: now,
      },
    });

    // Espelho administrativo da sessão (§12). A credencial real fica em baileys_auth_<orgId>/
    // e nunca entra aqui: gravamos apenas jid, aparelho e timestamps.
    const knownSession = await db.whatsAppSession.findFirst({
      where: { orgId, provider: opts.provider.toUpperCase() },
      orderBy: { createdAt: "desc" },
    });
    if (knownSession) {
      await db.whatsAppSession.update({
        where: { id: knownSession.id },
        data: { status: "ACTIVE", jid: opts.jid, lastSyncAt: now, pairedAt: knownSession.pairedAt ?? now, revokedAt: null },
      });
    } else {
      await db.whatsAppSession.create({
        data: {
          orgId,
          connectionId: conn.id,
          provider: opts.provider.toUpperCase(),
          jid: opts.jid,
          deviceId: opts.lid ?? null,
          authDir: `baileys_auth_${orgId}`,
          status: "ACTIVE",
          pairedAt: now,
          lastSyncAt: now,
        },
      });
    }
  }

  if (opts.state === "DISCONNECTED" || opts.state === "ERROR" || opts.state === "RECONNECT_REQUIRED") {
    const active = await db.whatsAppSession.findFirst({ where: { orgId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
    if (active) {
      await db.whatsAppSession.update({
        where: { id: active.id },
        data: { status: opts.state === "DISCONNECTED" ? "REVOKED" : "EXPIRED", revokedAt: now, lastSyncAt: now },
      });
    }
    if (opts.state === "DISCONNECTED") {
      await db.whatsAppAccount.updateMany({ where: { orgId }, data: { status: "LOGGED_OUT" } });
    }
  }

  const updated = await db.whatsAppConnection.update({
    where: { id: conn.id },
    data: {
      status: dbStatus as any,
      provider: opts.provider.toUpperCase(),
      phone: opts.phone ?? (opts.state === "CONNECTED" ? conn.phone : conn.phone),
      lastSyncAt: opts.state === "CONNECTED" ? now : conn.lastSyncAt,
    },
  });

  await logWa({
    orgId,
    level: opts.state === "ERROR" ? "error" : opts.state === "CONNECTED" ? "info" : "warn",
    event: "connection.status",
    actor: opts.phone ?? opts.jid ?? null,
    status: opts.state,
    detail: opts.detail ?? null,
  });

  publish({
    type: "connection.status",
    orgId,
    state: opts.state,
    detail: opts.detail,
    account: opts.jid
      ? { jid: opts.jid, lid: opts.lid ?? undefined, phone: opts.phone ?? undefined, name: opts.accountName ?? undefined }
      : null,
  });

  return updated;
}

/** Só publica: QR é efêmero e NÃO vai para o banco (§3 — "não armazenar QR desnecessariamente"). */
export function ingestQr(orgId: string, qrCode: string | null) {
  publish({ type: "qr", orgId, qrCode });
}

/** Ponto de entrada único dos adapters. */
export async function ingestEvent(event: NormalizedEvent): Promise<void> {
  const orgId = event.orgId;
  if (!orgId) {
    await logWa({ level: "warn", event: "ingest.no_org", detail: "Evento sem orgId foi descartado." });
    return;
  }

  switch (event.type) {
    case "message.upsert":
      await ingestMessage(orgId, event.message);
      return;
    case "message.status":
      await applyMessageStatus({
        orgId,
        providerMsgId: event.providerMsgId,
        status: event.status,
        detail: event.detail,
      });
      return;
    case "connection.status":
      await ingestConnection(orgId, {
        state: event.state,
        detail: event.detail,
        provider: process.env.WHATSAPP_PROVIDER ?? "bariels",
        jid: event.account?.jid ?? null,
        lid: event.account?.lid ?? null,
        phone: event.account?.phone ?? null,
        accountName: event.account?.name ?? null,
      });
      return;
    case "qr":
      ingestQr(orgId, event.qrCode);
      return;
    default:
      await logWa({ orgId, level: "error", event: "adapter.error", detail: event.message, status: event.code });
  }
}
