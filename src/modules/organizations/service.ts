import { db, type PrismaClientOrTx } from "@/lib/db";

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
  { event: "appointment.created", action: "schedule_reminder", config: { template: "reminder_24h", hoursBefore: 24 } },
  { event: "appointment.cancelled", action: "send_whatsapp", config: { template: "cancellation" } },
  { event: "appointment.rescheduled", action: "send_whatsapp", config: { template: "reschedule" } },
  // Remarcar cancela os lembretes na hora antiga (ver `events.ts`) e reagenda o lembrete na nova.
  { event: "appointment.rescheduled", action: "schedule_reminder", config: { template: "reminder_24h", hoursBefore: 24 } },
  { event: "appointment.completed", action: "schedule_reminder", config: { template: "post_visit", delayMinutes: 30 } },
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
