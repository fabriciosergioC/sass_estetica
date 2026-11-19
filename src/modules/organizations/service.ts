import { db, type PrismaClientOrTx } from "@/lib/db";
import { phoneKey, whatsappPhoneVariants } from "@/lib/phone";

type Tx = PrismaClientOrTx;

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

export async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "clinica";
  let candidate = root;
  let n = 2;
  while (await db.organization.findUnique({ where: { slug: candidate } })) {
    candidate = `${root}-${n}`;
    n++;
  }
  return candidate;
}

/**
 * Regra da plataforma: um número de WhatsApp pertence a UMA clínica.
 *
 * Compara por `phoneKey` porque o mesmo número é gravado de jeitos diferentes — o cadastro
 * grava "(11) 99999-9999", o painel grava "+55 11 99999-9999" e a conexão do WhatsApp grava
 * os dígitos internacionais. Também considera o número já pareado em `WhatsAppConnection` /
 * `WhatsAppAccount`: cada clínica tem a própria conexão, mas o mesmo aparelho do WhatsApp não
 * pode estar pareado em duas clínicas ao mesmo tempo.
 *
 * Devolve a clínica que já usa o número (sem expor o nome em telas públicas) ou `null`.
 */
export async function findOrganizationUsingPhone(
  rawPhone: string | null | undefined,
  opts: { excludeOrgId?: string; tx?: Tx } = {}
): Promise<{ id: string; name: string } | null> {
  const wanted = phoneKeys(rawPhone);
  if (wanted.size === 0) return null;
  const client = opts.tx ?? db;
  const otherOrg = opts.excludeOrgId ? { not: opts.excludeOrgId } : undefined;

  function uses(raw: string | null | undefined): boolean {
    for (const key of phoneKeys(raw)) {
      if (wanted.has(key)) return true;
    }
    return false;
  }

  const orgs = await client.organization.findMany({
    where: otherOrg ? { id: otherOrg } : undefined,
    select: { id: true, name: true, phone: true, whatsapp: true },
  });
  const org = orgs.find((o) => uses(o.phone) || uses(o.whatsapp));
  if (org) return { id: org.id, name: org.name };

  const connections = await client.whatsAppConnection.findMany({
    where: { phone: { not: null }, ...(otherOrg ? { orgId: otherOrg } : {}) },
    select: { orgId: true, phone: true, org: { select: { name: true } } },
  });
  const connection = connections.find((c) => uses(c.phone));
  if (connection) return { id: connection.orgId, name: connection.org.name };

  const accounts = await client.whatsAppAccount.findMany({
    where: { phone: { not: null }, ...(otherOrg ? { orgId: otherOrg } : {}) },
    select: { orgId: true, phone: true, org: { select: { name: true } } },
  });
  const account = accounts.find((a) => uses(a.phone));
  if (account) return { id: account.orgId, name: account.org.name };

  return null;
}

/**
 * Formas equivalentes do MESMO número: ignora pontuação/DDI e a variação do 9º dígito dos
 * celulares brasileiros (`11999999999` ↔ `1199999999`), que o WhatsApp trata como a mesma
 * linha. É a chave da regra "um WhatsApp por clínica".
 */
function phoneKeys(raw: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  const base = phoneKey(raw);
  if (base) keys.add(base);
  for (const variant of whatsappPhoneVariants(raw)) {
    const key = phoneKey(variant);
    if (key) keys.add(key);
  }
  return keys;
}

const DEFAULT_HOURS: Array<{ weekday: number; openTime: string; closeTime: string; closed: boolean }> = [
  { weekday: 0, openTime: "09:00", closeTime: "13:00", closed: true },
  { weekday: 1, openTime: "09:00", closeTime: "19:00", closed: false },
  { weekday: 2, openTime: "09:00", closeTime: "19:00", closed: false },
  { weekday: 3, openTime: "09:00", closeTime: "19:00", closed: false },
  { weekday: 4, openTime: "09:00", closeTime: "19:00", closed: false },
  { weekday: 5, openTime: "09:00", closeTime: "20:00", closed: false },
  { weekday: 6, openTime: "09:00", closeTime: "18:00", closed: false },
];

export const DEFAULT_TEMPLATES: Array<{ key: string; name: string; body: string }> = [
  {
    key: "confirmation",
    name: "Confirmação de agendamento",
    body: "Olá, {{cliente}}! Seu horário está confirmado: {{servico}} com {{barbeiro}} em {{data}} às {{hora}} na {{barbearia}}. Até logo! ✨",
  },
  {
    key: "reminder_24h",
    name: "Lembrete 24h antes",
    body: "Olá, {{cliente}}! Lembrete: seu horário na {{barbearia}} é amanhã, {{data}} às {{hora}}, com {{barbeiro}}. Confirma presença? Responda SIM para confirmar.",
  },
  {
    key: "reminder_2h",
    name: "Lembrete 2h antes",
    body: "Olá, {{cliente}}! Seu horário na {{barbearia}} é hoje às {{hora}} com {{barbeiro}}. Nos vemos em breve!",
  },
  {
    key: "cancellation",
    name: "Confirmação de cancelamento",
    body: "Olá, {{cliente}}! Seu horário de {{data}} às {{hora}} na {{barbearia}} foi cancelado. Quando quiser, é só agendar novamente. 🙏",
  },
  {
    key: "reschedule",
    name: "Confirmação de remarcação",
    body: "Olá, {{cliente}}! Seu horário na {{barbearia}} foi remarcado para {{data}} às {{hora}} com {{barbeiro}}.",
  },
  {
    key: "post_visit",
    name: "Pós-atendimento",
    body: "Olá, {{cliente}}! Obrigado pela visita na {{barbearia}}! Esperamos você novamente. Se puder, deixe sua avaliação. ✨",
  },
  {
    key: "return_due",
    name: "Retorno atrasado",
    body: "Olá, {{cliente}}! Já faz um tempinho desde sua última visita na {{barbearia}}. Vamos agendar? Temos horários disponíveis essa semana. ✨",
  },
  {
    key: "slot_recovery",
    name: "Recuperação de horário",
    body: "Olá, {{cliente}}! Surgiu um horário hoje às {{hora}} na {{barbearia}} com {{barbeiro}}. Gostaria de aproveitar? É só responder aqui.",
  },
];

/**
 * As regras que toda clínica nova recebe. Exportada porque `scripts/add-default-rules.ts`
 * aplica exatamente esta lista em quem já existe — ter as duas cópias foi como o lembrete de
 * 2h ficou meses sem regra nenhuma.
 *
 * Os dois lembretes saem do horário do agendamento, na criação: depender de
 * `appointment.confirmed` faria o lembrete existir só para quem aperta o botão de confirmar,
 * e o cliente que agenda pelo link nunca aperta.
 */
export const DEFAULT_RULES: Array<{ event: string; action: string; config: Record<string, unknown> }> = [
  // Par fixo do menu (um interruptor só, ver src/modules/automation/rules.ts):
  //   mesmo dia → confirmação; próximo dia ou mais → lembrete de 24h.
  // As duas precisam existir juntas para o interruptor conseguir ligá-las/desligá-las.
  { event: "appointment.created", action: "send_whatsapp", config: { template: "confirmation" } },
  { event: "appointment.created", action: "schedule_reminder", config: { template: "reminder_24h", hoursBefore: 24 } },
  { event: "appointment.cancelled", action: "send_whatsapp", config: { template: "cancellation" } },
  { event: "appointment.rescheduled", action: "send_whatsapp", config: { template: "reschedule" } },
  // Remarcar cancela os lembretes na hora antiga (ver `events.ts`) e reagenda o lembrete na nova.
  { event: "appointment.rescheduled", action: "schedule_reminder", config: { template: "reminder_24h", hoursBefore: 24 } },
  // Pós-atendimento sai junto com a conclusão do serviço. Era 30 min de espera e o cliente
  // (e o operador) ficavam sem o agradecimento justamente na hora do caixa.
  { event: "appointment.completed", action: "schedule_reminder", config: { template: "post_visit", delayMinutes: 0 } },
  // Cliente que não volta há 3 semanas. Não é um evento da Agenda: a varredura diária em
  // `src/modules/automation/return-due.ts` publica `customer.return_due` para quem está na
  // régua, e esta regra faz o convite sair pelo template "Retorno atrasado".
  { event: "customer.return_due", action: "send_whatsapp", config: { template: "return_due" } },
];

/** Provisiona uma nova barbearia com padrões sensatos. */
export async function provisionOrganization(opts: {
  name: string;
  slug: string;
  phone?: string;
  whatsapp?: string;
  adminUserId: string;
  planCode?: string;
  tx?: Tx;
}) {
  const client = opts.tx ?? db;
  const plan =
    (await client.plan.findUnique({ where: { code: opts.planCode ?? "FREE" } })) ??
    (await client.plan.findFirst({ orderBy: { sortOrder: "asc" } }));

  const org = await client.organization.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      phone: opts.phone,
      whatsapp: opts.whatsapp,
      members: {
        create: { userId: opts.adminUserId, role: "ADMIN", status: "ACTIVE" },
      },
      businessHours: { create: DEFAULT_HOURS },
      templates: { create: DEFAULT_TEMPLATES },
      automationRules: {
        create: DEFAULT_RULES.map((r) => ({ ...r, config: JSON.stringify(r.config) })),
      },
      waConnections: { create: { provider: "DEV", status: "DISCONNECTED" } },
      ...(plan
        ? { subscription: { create: { planId: plan.id, status: "ACTIVE" } } }
        : {}),
    },
  });

  return org;
}
