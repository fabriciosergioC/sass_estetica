/**
 * Diagnóstico (100% leitura) do "segundo WhatsApp" que chega ao confirmar um agendamento.
 *
 * Uso: npm run diag:lembretes
 *   ou: npx tsx --env-file=.env scripts/diag-lembretes.ts [slug]
 *
 * Mostra, sem escrever nada e sem revelar segredo:
 *   1. as regras de automação habilitadas da organização (evento, ação, config);
 *   2. os últimos agendamentos com o horário de início;
 *   3. as últimas mensagens OUT com template, status, quando foram criadas, quando o envio
 *      foi agendado (Job.runAt) e quando de fato sairam;
 *   4. o que a função `decisaoLembrete` (a mesma que roda no evento) decide para os
 *      agendamentos reais e para uma tabela de cenários — prova, sem enviar nada, de que
 *      lembrete de horário do mesmo dia não sai mais em cima da confirmação, e o do dia
 *      seguinte continua saindo.
 */
import { PrismaClient } from "@prisma/client";
import { decisaoLembrete } from "@/modules/automation/events";

const db = new PrismaClient();

const slug = process.argv[2] || "bela-face";

function hora(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour12: false });
}

async function main() {
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org) {
    console.log(`Organização não encontrada: ${slug}`);
    return;
  }
  console.log(`\n=== ${org.name} (${org.slug}) ===`);

  const rules = await db.automationRule.findMany({
    where: { orgId: org.id },
    orderBy: [{ event: "asc" }, { createdAt: "asc" }],
  });
  console.log(`\nRegras de automação (${rules.length}):`);
  for (const r of rules) {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(r.config || "{}");
    } catch {
      cfg = { _configInvalido: r.config };
    }
    console.log(
      `  ${r.enabled ? "[on ]" : "[off]"} ${r.event.padEnd(24)} ${r.action.padEnd(18)} ${JSON.stringify(cfg)}`
    );
  }

  const appointments = await db.appointment.findMany({
    where: { orgId: org.id },
    orderBy: { startAt: "desc" },
    take: 5,
    include: {
      customer: { select: { name: true } },
      service: { select: { name: true } },
      barber: { select: { name: true } },
    },
  });
  console.log(`\nÚltimos agendamentos (${appointments.length}):`);
  for (const a of appointments) {
    console.log(
      `  ${hora(a.startAt)} | ${a.status.padEnd(10)} | ${a.customer.name} | ${a.service?.name ?? "?"} | ${a.barber?.name ?? "?"} | criado ${hora(a.createdAt)}`
    );
  }

  const messages = await db.whatsAppMessage.findMany({
    where: { orgId: org.id, direction: "OUT" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log(`\nÚltimas mensagens enviadas/saídas (${messages.length}):`);
  for (const m of messages) {
    const jobs = await db.job.findMany({
      where: { type: "send_whatsapp", payload: { contains: m.id } },
      select: { runAt: true, status: true },
    });
    console.log(
      `  ${hora(m.createdAt)} → ${hora(m.sentAt)} | ${(m.templateKey ?? "manual").padEnd(14)} ${m.status.padEnd(9)} | jobs: ${
        jobs.length ? jobs.map((j) => `${hora(j.runAt)}/${j.status}`).join(", ") : "nenhum"
      }`
    );
    console.log(`      "${m.body.replace(/\s+/g, " ").slice(0, 120)}"`);
  }

  // O que o motor decide HOJE para cada agendamento futuro, usando a função real
  // (`decisaoLembrete`, exportada de `events.ts`) — sem enviar nada, sem escrever nada.
  const reminderRules = rules.filter((r) => r.enabled && r.action === "schedule_reminder");
  const futuros = appointments.filter((a) => a.startAt.getTime() > Date.now() && a.status !== "CANCELLED").slice(0, 3);
  const alvos = futuros.length ? futuros : appointments.slice(0, 1);
  if (reminderRules.length && alvos.length) {
    console.log(`\nO que a automação decide agora (mesma função que roda no evento, nada foi enviado):`);
    for (const a of alvos) {
      console.log(`  agendamento ${hora(a.startAt)} — ${a.customer.name} (${a.status})`);
      for (const r of reminderRules) {
        let cfg: { template?: string; hoursBefore?: number; delayMinutes?: number } = {};
        try {
          cfg = JSON.parse(r.config || "{}");
        } catch {
          /* config inválida: o próprio motor registra a falha */
        }
        const d = decisaoLembrete(cfg, a.startAt);
        console.log(
          `    ${r.event.padEnd(24)} ${String(cfg.template).padEnd(14)} → ${
            d.runAt ? "enviar em " + hora(d.runAt) : "NÃO ENVIA"
          } | ${d.motivo}`
        );
      }
    }
  }

  console.log("");
}

/**
 * Cenários sintéticos da decisão — não tocam banco nem WhatsApp, é a prova de que a regra
 * nova continua mandando o lembrete de quem agenda para o dia seguinte.
 */
function cenarios() {
  const D = (dia: number, h: number) => new Date(2026, 10, dia, h, 0);
  // [nome, "agora", startAt do agendamento, config da regra]
  const casos: Array<[string, Date, Date, Record<string, number>]> = [
    ["mesmo dia, confirmado 5h antes (o bug de 03/11)", D(3, 7), D(3, 12), { hoursBefore: 24 }],
    ["mesmo dia, lembrete de 2h ainda dá tempo", D(3, 7), D(3, 12), { hoursBefore: 2 }],
    ["mesmo dia, em cima da hora (2h antes já era)", D(3, 7), D(3, 8), { hoursBefore: 2 }],
    ["DIA SEGUINTE: agendou 20h de hoje para 10h de amanhã", D(3, 20), D(4, 10), { hoursBefore: 24 }],
    ["DIA SEGUINTE: agendou 07h de hoje para 09h de amanhã", D(3, 7), D(4, 9), { hoursBefore: 24 }],
    ["daqui a 5 dias", D(3, 7), D(8, 15), { hoursBefore: 24 }],
    ["horário que já passou", D(3, 20), D(2, 18), { hoursBefore: 24 }],
    ["pós-atendimento (regra por atraso, sem hoursBefore)", D(3, 7), D(2, 18), { delayMinutes: 30 }],
  ];

  console.log(`\nCenários:`);
  for (const [nome, agora, startAt, cfg] of casos) {
    const d = decisaoLembrete(cfg, startAt, agora);
    console.log(
      `  ${nome.padEnd(52)} ${hora(agora)} → ${(d.runAt ? "enviar " + hora(d.runAt) : "NÃO ENVIA").padEnd(26)} ${d.motivo}`
    );
  }
  console.log("");
}

main()
  .then(cenarios)
  .catch((e) => console.error(e))
  .finally(() => db.$disconnect());
