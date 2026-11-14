import { db } from "@/lib/db";
import { containsCI } from "@/lib/search";
import { whatsappPhoneVariants } from "@/lib/phone";
import { logWa } from "./logs";
import { publish } from "./bus";

/**
 * leitura e mutações do painel de conversas (§4 a §9).
 *
 * Separado do `service.ts` porque são duas naturezas: o service decide CONEXÃO e ENVIO (fala
 * com o adapter); este arquivo só mexe no que já está no nosso banco. Nenhuma função daqui
 * importa Baileys — é isso que faz a tela funcionar igual no modo mock.
 */

export type ConversationFilter =
  | "all"
  | "appointments"
  | "in_progress"
  | "waiting"
  | "done";

const FILTER_WHERE: Record<Exclude<ConversationFilter, "all" | "appointments">, Record<string, unknown>> = {
  in_progress: { status: "IN_PROGRESS" },
  waiting: { status: "WAITING_CUSTOMER" },
  done: { status: "DONE" },
};

/**
 * Condição de "esta conversa é de um cliente cadastrado".
 *
 * O painel do WhatsApp não é caixa de entrada de número desconhecido: só entra quem existe no
 * menu Clientes (e, portanto, na Agenda). O vínculo pode estar na conversa ou só no contato —
 * os dois contam, porque o caminho antigo gravava apenas no contato.
 *
 * `not: null` (e não `customerId: { in: ... }`) de propósito: a FK garante que o id existe,
 * então qualquer vínculo aponta para uma ficha real do CRM.
 */
const LINKED_TO_CUSTOMER = {
  OR: [{ customerId: { not: null } }, { contact: { customerId: { not: null } } }],
} as const;

export type ConversationListItem = {
  id: string;
  status: string;
  unreadCount: number;
  lastMessageAt: Date;
  lastBody: string | null;
  archived: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  contact: { id: string; jid: string; name: string | null; phone: string | null; masked: boolean };
  customer: { id: string; name: string; phone: string } | null;
  labels: { id: string; name: string; color: string }[];
  /** Última mensagem para a prévia da lista (direção muda o alinhamento na tela). */
  lastMessage: { direction: string; body: string; createdAt: Date; status: string } | null;
};

export async function listConversations(
  orgId: string,
  opts: { filter?: ConversationFilter; search?: string; userId?: string | null; take?: number; skip?: number } = {}
): Promise<{ items: ConversationListItem[]; total: number }> {
  const filter = opts.filter ?? "all";
  const where: Record<string, any> = { orgId, archived: false };
  // Toda aba — inclusive "Todas" — só enxerga conversa de cliente cadastrado. Número que
  // mandou mensagem sem estar no CRM fica gravado no banco, mas fora da lista; quando o
  // cliente é cadastrado (Clientes/Agenda), `linkWhatsAppToCustomer` liga o histórico e a
  // conversa aparece.
  const and: Record<string, any>[] = [{ ...LINKED_TO_CUSTOMER }];

  // As abas do painel (Agendamentos, Em atendimento, Aguardando resposta e Finalizadas) são
  // recortes da AGENDA: só entram conversas de clientes que possuem agendamento. Antes elas
  // eram só um filtro de status da conversa, então qualquer contato que mandasse "oi" aparecia
  // em "Finalizadas"/"Aguardando resposta" mesmo sem nunca ter sido agendado.
  if (filter === "appointments") {
    // A aba "Agendamentos" é a agenda de hoje em diante (horário ativo); as demais abas
    // aceitam qualquer agendamento do cliente, senão "Finalizadas" nunca teria ninguém.
    const appointments = await db.appointment.findMany({
      where: { orgId, status: { in: ["SCHEDULED", "CONFIRMED", "IN_SERVICE"] } },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    const customerIds = [...new Set(appointments.map((a) => a.customerId).filter(Boolean))];

    // O vínculo do cliente pode estar na conversa ou só no contato — é o caso mais comum de
    // quem chegou pelo WhatsApp e foi agendado depois no menu Agenda.
    and.push({
      OR: [
        { customerId: { in: customerIds } },
        { contact: { customerId: { in: customerIds } } },
      ],
    });
  } else if (filter !== "all") {
    and.push({ ...FILTER_WHERE[filter] });
  }

  const q = opts.search?.trim();
  if (q) {
    const matching = await db.whatsAppMessage.findMany({
      where: { orgId, body: containsCI(q) },
      select: { conversationId: true },
      take: 400,
    });
    const fromText = [...new Set(matching.map((m) => m.conversationId).filter(Boolean) as string[])];

    and.push({
      OR: [
        { contact: { name: containsCI(q) } },
        { contact: { phone: containsCI(q.replace(/\D/g, "") || q) } },
        { contact: { jid: containsCI(q) } },
        { customer: { name: containsCI(q) } },
        ...(fromText.length ? [{ id: { in: fromText } }] : []),
      ],
    });
  }

  where.AND = and;

  const [rows, total] = await Promise.all([
    db.whatsAppConversation.findMany({
      where: where as any,
      include: {
        contact: true,
        customer: { select: { id: true, name: true, phone: true } },
        assignee: { select: { id: true, name: true } },
        labels: { include: { label: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { lastMessageAt: "desc" },
      skip: opts.skip ?? 0,
      take: opts.take ?? 50,
    }),
    db.whatsAppConversation.count({ where: where as any }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      unreadCount: r.unreadCount,
      lastMessageAt: r.lastMessageAt,
      lastBody: r.lastBody,
      archived: r.archived,
      assigneeId: r.assigneeId,
      assigneeName: r.assignee?.name ?? null,
      contact: {
        id: r.contact.id,
        jid: r.contact.jid,
        name: r.contact.name,
        phone: r.contact.phone,
        masked: r.contact.masked,
      },
      customer: r.customer ?? null,
      labels: r.labels.map((l) => l.label),
      lastMessage: r.messages[0]
        ? {
            direction: r.messages[0].direction,
            body: r.messages[0].body,
            createdAt: r.messages[0].createdAt,
            status: r.messages[0].status,
          }
        : null,
    })),
    total,
  };
}

export async function listTeam(orgId: string) {
  const members = await db.organizationMember.findMany({
    where: { orgId, status: "ACTIVE" },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { role: "asc" },
  });
  return members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
}

export async function listMessages(
  orgId: string,
  opts: {
    conversationId?: string | null;
    customerId?: string | null;
    direction?: "IN" | "OUT" | null;
    status?: string | null;
    search?: string | null;
    take?: number;
    skip?: number;
  } = {}
) {
  const where: Record<string, unknown> = { orgId };
  if (opts.conversationId) where.conversationId = opts.conversationId;
  if (opts.customerId) where.customerId = opts.customerId;
  if (opts.direction) where.direction = opts.direction;
  if (opts.status) where.status = opts.status;
  const q = opts.search?.trim();
  if (q) where.body = containsCI(q);

  const [items, total] = await Promise.all([
    db.whatsAppMessage.findMany({
      where: where as any,
      orderBy: { createdAt: "desc" },
      take: Math.min(100, opts.take ?? 50),
      skip: opts.skip ?? 0,
      include: {
        conversation: { include: { contact: { select: { id: true, jid: true, name: true, phone: true, masked: true } } } },
        customer: { select: { id: true, name: true } },
        media: true,
      },
    }),
    db.whatsAppMessage.count({ where: where as any }),
  ]);

  return { items, total };
}

export async function listContacts(orgId: string, opts: { search?: string; take?: number; skip?: number } = {}) {
  const where: Record<string, unknown> = { orgId };
  const q = opts.search?.trim();
  if (q) {
    where.OR = [
      { name: containsCI(q) },
      { phone: containsCI(q.replace(/\D/g, "") || q) },
      { jid: containsCI(q) },
    ];
  }

  const [items, total] = await Promise.all([
    db.whatsAppContact.findMany({
      where: where as any,
      orderBy: { lastSeenAt: "desc" },
      take: Math.min(200, opts.take ?? 60),
      skip: opts.skip ?? 0,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        conversations: { select: { id: true, lastMessageAt: true, unreadCount: true }, take: 1, orderBy: { lastMessageAt: "desc" } },
      },
    }),
    db.whatsAppContact.count({ where: where as any }),
  ]);

  return { items, total };
}

/**
 * Liga o histórico do WhatsApp a um cliente cadastrado pelo telefone.
 *
 * O painel de conversas só lista cliente do CRM — então quem mandou mensagem antes de existir
 * como cliente ficaria com o histórico invisível para sempre. Chamar isto no cadastro (menu
 * Clientes) resolve o caso mais comum: a pessoa fala primeiro, o atendente cadastra depois e a
 * conversa antiga aparece com todo o papo, em vez de começar do zero.
 *
 * A comparação usa `whatsappPhoneVariants` porque o CRM grava `+31987707962` e o WhatsApp
 * grava `5531987707962`/`553187707962` — igualdade simples não acharia nada.
 */
export async function linkWhatsAppToCustomer(
  orgId: string,
  customer: { id: string; phone?: string | null }
): Promise<number> {
  const variants = whatsappPhoneVariants(customer.phone);
  if (!variants.length) return 0;

  const jids = variants.map((v) => `${v}@s.whatsapp.net`);
  const contacts = await db.whatsAppContact.findMany({
    where: { orgId, OR: [{ phone: { in: variants } }, { jid: { in: jids } }] },
    select: { id: true },
  });
  if (!contacts.length) return 0;

  const contactIds = contacts.map((c) => c.id);
  const conversations = await db.whatsAppConversation.findMany({
    where: { orgId, contactId: { in: contactIds } },
    select: { id: true },
  });

  await db.whatsAppContact.updateMany({
    where: { orgId, id: { in: contactIds } },
    data: { customerId: customer.id },
  });
  await db.whatsAppConversation.updateMany({
    where: { orgId, contactId: { in: contactIds } },
    data: { customerId: customer.id },
  });
  await db.whatsAppMessage.updateMany({
    where: { orgId, contactId: { in: contactIds } },
    data: { customerId: customer.id },
  });

  for (const conversation of conversations) {
    publish({ type: "conversation.changed", orgId, conversationId: conversation.id });
  }
  await logWa({
    orgId,
    event: "conversation.linked",
    actor: customer.id,
    status: `cadastro:${conversations.length}`,
    detail: "histórico do WhatsApp ligado ao cliente pelo telefone",
  });
  return conversations.length;
}

export async function getConversation(orgId: string, conversationId: string, messageLimit = 100) {
  const conversation = await db.whatsAppConversation.findFirst({
    where: { id: conversationId, orgId },
    include: {
      contact: true,
      customer: { select: { id: true, name: true, phone: true, whatsappOptIn: true, notes: true } },
      assignee: { select: { id: true, name: true } },
      labels: { include: { label: true } },
      followUps: { orderBy: { scheduledAt: "desc" }, take: 5 },
      messages: {
        where: { orgId },
        orderBy: { createdAt: "desc" },
        take: messageLimit,
        include: { media: true },
      },
    },
  });
  if (!conversation) return null;

  return {
    ...conversation,
    labels: conversation.labels.map((l) => l.label),
    messages: [...conversation.messages].reverse(),
  };
}

/** Zera o contador ao abrir a conversa (§5).
 *
 * Só avança de OPEN para IN_PROGRESS: um status que o atendente já definiu
 * (DONE, WAITING_CUSTOMER, IN_PROGRESS) não deve ser sobrescrito só porque
 * ele abriu a conversa de novo — caso contrário a alteração some ao recarregar a página.
 *
 * E nem avança quando o cliente tem horário à frente na Agenda: quem cria o agendamento
 * na tela de Agenda quer ver o chat ABERTA ali, e abrir a conversa para ler não é
 * "iniciar o atendimento" — isso continua sendo um ato do atendente no seletor de status.
 */
export async function markConversationRead(orgId: string, conversationId: string) {
  const conversation = await db.whatsAppConversation.findFirst({
    where: { id: conversationId, orgId },
    select: { id: true, status: true, customerId: true, contact: { select: { customerId: true } } },
  });
  if (!conversation) return false;

  const data: { unreadCount: number; status?: string } = { unreadCount: 0 };
  if (conversation.status === "OPEN") {
    const customerId = conversation.customerId ?? conversation.contact?.customerId ?? null;
    const upcoming = customerId
      ? await db.appointment.count({
          where: { orgId, customerId, status: { in: ["SCHEDULED", "CONFIRMED"] }, startAt: { gte: new Date() } },
        })
      : 0;
    if (upcoming === 0) data.status = "IN_PROGRESS";
  }

  const updated = await db.whatsAppConversation.updateMany({
    where: { id: conversationId, orgId },
    data,
  });
  if (updated.count) publish({ type: "conversation.changed", orgId, conversationId });
  return updated.count > 0;
}

export async function setConversationStatus(orgId: string, conversationId: string, status: string, userId?: string) {
  const conversation = await db.whatsAppConversation.findFirst({ where: { id: conversationId, orgId } });
  if (!conversation) return null;
  const updated = await db.whatsAppConversation.update({ where: { id: conversationId }, data: { status } });

  // Sincronizar com a agenda se houver customerId
  if (conversation.customerId) {
    const appt = await db.appointment.findFirst({
      where: {
        orgId,
        customerId: conversation.customerId,
        status: { in: ["SCHEDULED", "CONFIRMED", "IN_SERVICE"] },
      },
      orderBy: { startAt: "asc" },
    });

    if (appt) {
      let targetAppointmentStatus: string | null = null;
      if (status === "DONE") targetAppointmentStatus = "COMPLETED";
      else if (status === "IN_PROGRESS") targetAppointmentStatus = "IN_SERVICE";

      if (targetAppointmentStatus) {
        try {
          const { changeStatus: changeAppointmentStatus } = await import("@/modules/scheduling/appointments");
          await changeAppointmentStatus({
            orgId,
            userId,
            appointmentId: appt.id,
            to: targetAppointmentStatus as any,
            reason: "Sincronizado automaticamente via status do WhatsApp",
          });
        } catch (err) {
          console.error("[WhatsApp] Falha ao sincronizar status com a agenda:", err);
        }
      }
    }
  }

  await logWa({
    orgId,
    event: "conversation.status",
    actor: userId ?? null,
    detail: `${conversation.status} → ${status}`,
    status,
  });
  publish({ type: "conversation.changed", orgId, conversationId });
  return updated;
}

export async function assignConversation(orgId: string, conversationId: string, assigneeId: string | null) {
  const updated = await db.whatsAppConversation.updateMany({
    where: { id: conversationId, orgId },
    data: { assigneeId },
  });
  if (updated.count) publish({ type: "conversation.changed", orgId, conversationId });
  return updated.count > 0;
}

export async function archiveConversation(orgId: string, conversationId: string, archived = true) {
  const updated = await db.whatsAppConversation.updateMany({
    where: { id: conversationId, orgId },
    data: { archived },
  });
  if (updated.count) publish({ type: "conversation.changed", orgId, conversationId });
  return updated.count > 0;
}

/**
 * Vincula a conversa ao CRM (§9). Duas pontas possíveis: cliente já cadastrado ou apenas o
 * contato do WhatsApp — por isso aceitamos `customerId` e opcionalmente renomeamos o contato.
 */
export async function linkConversationCustomer(orgId: string, conversationId: string, customerId: string | null) {
  if (customerId) {
    const customer = await db.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true } });
    if (!customer) return null;
  }

  const conversation = await db.whatsAppConversation.findFirst({ where: { id: conversationId, orgId } });
  if (!conversation) return null;

  await db.whatsAppMessage.updateMany({
    where: { conversationId, orgId },
    data: { customerId },
  });

  const updated = await db.whatsAppConversation.update({
    where: { id: conversationId },
    data: { customerId },
  });
  await db.whatsAppContact.update({
    where: { id: conversation.contactId },
    data: { customerId },
  });

  await logWa({ orgId, event: "conversation.linked", actor: customerId ?? "sem cliente", status: "ok" });
  publish({ type: "conversation.changed", orgId, conversationId });
  return updated;
}

/**
 * "Criar Lead" (§8): o número que mandou mensagem vira cliente do CRM e a conversa passa a
 * apontar para ele. Não inventamos pipeline neste projeto — o objeto de CRM é o Customer, e
 * as oportunidades do funil já vivem em `Opportunity`.
 */
export async function createCustomerFromConversation(opts: {
  orgId: string;
  conversationId: string;
  name: string;
  phone?: string | null;
  userId?: string | null;
}) {
  const conversation = await db.whatsAppConversation.findFirst({
    where: { id: opts.conversationId, orgId: opts.orgId },
    include: { contact: true },
  });
  if (!conversation) return null;

  const phone = (opts.phone ?? conversation.contact.phone ?? "").replace(/\D/g, "");
  if (!phone) {
    throw new Error("Este contato chegou mascarado pelo WhatsApp (@lid) e não tem número para cadastrar.");
  }

  const existing = await db.customer.findFirst({ where: { orgId: opts.orgId, phone } });
  const customer =
    existing ??
    (await db.customer.create({
      data: { orgId: opts.orgId, name: opts.name, phone, whatsappOptIn: true },
    }));

  await db.whatsAppContact.update({ where: { id: conversation.contactId }, data: { customerId: customer.id } });
  await db.whatsAppConversation.update({ where: { id: conversation.id }, data: { customerId: customer.id } });
  await db.whatsAppMessage.updateMany({
    where: { conversationId: conversation.id, orgId: opts.orgId },
    data: { customerId: customer.id },
  });

  await db.customerNote.create({
    data: {
      orgId: opts.orgId,
      customerId: customer.id,
      authorId: opts.userId ?? null,
      content: "Contato criado a partir de uma conversa do WhatsApp.",
    },
  });

  await logWa({ orgId: opts.orgId, event: "customer.created_from_whatsapp", actor: phone, status: customer.id });
  publish({ type: "conversation.changed", orgId: opts.orgId, conversationId: conversation.id });

  return { customer, conversationId: conversation.id };
}

export type TimelineEntry = { at: Date; kind: string; label: string; detail?: string | null };

/**
 * Timeline do lead (§10) montada como leitura, não como tabela nova.
 *
 * Optamos por agregar o que já existe (cadastro, mensagens, observações, etiquetas,
 * follow-ups, conexões) em vez de criar uma `timeline` paralela: duplicar evento em duas
 * tabelas é como histórico passa a discordar de si mesmo.
 */
export async function customerTimeline(orgId: string, customerId: string, limit = 60): Promise<TimelineEntry[]> {
  const [customer, messages, notes, followUps, conversations] = await Promise.all([
    db.customer.findFirst({ where: { id: customerId, orgId }, select: { id: true, createdAt: true } }),
    db.whatsAppMessage.findMany({
      where: { orgId, customerId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.customerNote.findMany({ where: { orgId, customerId }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.whatsAppFollowUp.findMany({ where: { orgId, customerId }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.whatsAppConversation.findMany({
      where: { orgId, customerId },
      include: { labels: { include: { label: true } } },
      take: 10,
    }),
  ]);

  const entries: TimelineEntry[] = [];

  if (customer) entries.push({ at: customer.createdAt, kind: "created", label: "Lead cadastrado" });

  for (const m of messages) {
    entries.push({
      at: m.createdAt,
      kind: "message",
      label: m.direction === "IN" ? "Mensagem recebida" : "Mensagem enviada",
      detail: m.body.slice(0, 120),
    });
  }

  for (const n of notes) {
    entries.push({ at: n.createdAt, kind: "note", label: "Observação adicionada", detail: n.content.slice(0, 120) });
  }

  for (const f of followUps) {
    entries.push({
      at: f.createdAt,
      kind: "followup",
      label: f.status === "DONE" ? "Follow-up concluído" : "Follow-up agendado",
      detail: `${f.reason} — ${f.scheduledAt.toLocaleString("pt-BR")}`,
    });
  }

  for (const c of conversations) {
    for (const assignment of c.labels) {
      entries.push({ at: assignment.createdAt, kind: "label", label: `Etiqueta: ${assignment.label.name}` });
    }
  }

  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
