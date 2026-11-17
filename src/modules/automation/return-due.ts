// Regra "Retorno atrasado" (return_due): cliente que não volta há 3 semanas recebe o convite
// para agendar de novo.
//
// Não existe evento de "o tempo passou" — por isso a regra não nasce de um clique na Agenda:
// uma varredura diária (worker do app ou /api/cron) publica `customer.return_due` para cada
// cliente elegível e o motor de regras faz o envio pelo template, respeitando o interruptor
// do menu Automações.
import { db } from "@/lib/db";
import { BUSINESS_TIME_ZONE } from "@/lib/datetime";
import { DEFAULT_RULES, DEFAULT_TEMPLATES } from "@/modules/organizations/service";
import { publishEvent } from "./events";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 3 semanas sem atendimento. Ajustável por env para clínicas com ciclo diferente. */
export const RETURN_DUE_DAYS = (() => {
  const raw = Number(process.env.RETURN_DUE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 21;
})();

/**
 * Janela de envio no fuso da loja (8h–20h).
 *
 * A varredura roda no worker logo que o processo sobe — um deploy às 3h da manhã mandaria o
 * convite de retorno de madrugada. Fora da janela, a varredura espera o próximo ciclo.
 */
export function returnDueWindowOpen(now: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: BUSINESS_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now)
  );
  return hour >= 8 && hour < 20;
}

/**
 * Garante que a org tenha o template e a regra desta automação.
 *
 * Org antiga só ganha as regras padrão ao abrir o menu Automações (GET /api/automations).
 * A varredura não pode depender de alguém abrir a tela: sem isto, o retorno atrasado nunca
 * sairia justamente nas clínicas que já existiam antes da regra.
 */
async function ensureReturnDueProvisioned(orgId: string) {
  const [template, rule] = await Promise.all([
    db.messageTemplate.findUnique({ where: { orgId_key: { orgId, key: "return_due" } } }),
    db.automationRule.findFirst({
      where: { orgId, event: "customer.return_due", action: "send_whatsapp" },
    }),
  ]);

  if (!template) {
    const def = DEFAULT_TEMPLATES.find((t) => t.key === "return_due");
    if (def) await db.messageTemplate.create({ data: { orgId, ...def } }).catch(() => {});
  }
  if (!rule) {
    const def = DEFAULT_RULES.find(
      (r) => r.event === "customer.return_due" && r.action === "send_whatsapp"
    );
    if (def) {
      await db.automationRule
        .create({ data: { orgId, event: def.event, action: def.action, config: JSON.stringify(def.config) } })
        .catch(() => {});
    }
  }
}

/**
 * Dispara o retorno atrasado para os clientes elegíveis da org.
 *
 * Elegível = tem atendimento CONCLUÍDO, a última visita foi há mais de `RETURN_DUE_DAYS`, não
 * tem horário futuro nem atendimento em andamento e não recebeu um `return_due` nas últimas
 * 3 semanas (o cooldown é o que impede o cliente de receber a mesma mensagem todo dia).
 *
 * Retorna quantos clientes entraram na régua — o envio em si respeita a regra ligada/desligada
 * e o template habilitado.
 */
export async function sendReturnDueMessages(orgId: string): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETURN_DUE_DAYS * DAY_MS);
  // Atendimento em andamento é cliente na loja agora: nada de "sentimos sua falta".
  const inServiceSince = new Date(now.getTime() - DAY_MS);

  const customers = await db.customer.findMany({
    where: {
      orgId,
      whatsappOptIn: true,
      AND: [
        // Sem próximo horário marcado.
        {
          appointments: {
            none: { startAt: { gte: now }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
          },
        },
        // Sem atendimento em andamento (a janela de 1 dia cobre horário que começou ontem à noite).
        {
          appointments: {
            none: { startAt: { gte: inServiceSince }, status: "IN_SERVICE" },
          },
        },
      ],
    },
    select: {
      id: true,
      phone: true,
      // Última visita de verdade: só CONCLUÍDO conta. Falta/cancelamento não é visita.
      appointments: {
        where: { status: "COMPLETED" },
        orderBy: { startAt: "desc" },
        take: 1,
        select: { startAt: true },
      },
      // Cooldown: já recebeu o convite há menos de 3 semanas?
      messages: {
        where: {
          templateKey: "return_due",
          createdAt: { gte: cutoff },
          status: { notIn: ["CANCELLED", "FAILED"] },
        },
        select: { id: true },
        take: 1,
      },
    },
    // Clínica cabe folgado neste teto; o filtro fino (última visita) é feito abaixo porque o
    // Prisma não compara o MAX(startAt) de uma relação.
    take: 1000,
  });

  const eligible = customers.filter(
    (c) =>
      c.phone?.trim() &&
      c.appointments[0] &&
      c.appointments[0].startAt < cutoff &&
      c.messages.length === 0
  );
  if (eligible.length === 0) return 0;

  await ensureReturnDueProvisioned(orgId);

  for (const customer of eligible) {
    await publishEvent(orgId, "customer.return_due", { customerId: customer.id });
  }
  return eligible.length;
}

/** Roda a varredura em todas as orgs ativas (worker diário e /api/cron). */
export async function sweepReturnDueForAllOrgs(): Promise<{ orgs: number; customers: number }> {
  const orgs = await db.organization.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
    take: 100,
  });
  let customers = 0;
  for (const org of orgs) {
    customers += await sendReturnDueMessages(org.id);
  }
  return { orgs: orgs.length, customers };
}
