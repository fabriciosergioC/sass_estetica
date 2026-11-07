/**
 * Aplica as regras de automação padrão nas clínicas que já existem no banco.
 *
 * Uso: npx tsx --env-file=.env scripts/add-default-rules.ts [--dry]
 *
 * A lista vem de `DEFAULT_RULES` do módulo de organizações — não de uma cópia escrita aqui.
 * Ter a segunda cópia foi exatamente o que deixou o "Lembrete 2h antes" sem regra: o cadastro
 * de uma clínica nova e este script passaram a descrever coisas diferentes.
 *
 * Idempotente por (orgId, event, action, config.template):
 *  - existe e está igual            → nada;
 *  - existe com outro config        → ajusta o config (mantém o estado ligado/desligado);
 *  - não existe                     → cria;
 *  - lembrete de 24h preso em `appointment.confirmed` → desliga (virou regra de criação;
 *    apagar seria perder o histórico de execuções, e ele continua ligado na tela de Automações
 *    se alguém quiser de volta).
 */
import { PrismaClient } from "@prisma/client";
import { DEFAULT_RULES } from "@/modules/organizations/service";

const db = new PrismaClient();

/** A mesma chave que `sendTemplateMessage` usa para não mandar duas vezes a mesma peça. */
function templateDe(config: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(config || "{}") as { template?: string };
    return parsed.template ?? null;
  } catch {
    return null;
  }
}

function igual(a: Record<string, unknown>, b: string): boolean {
  const atual = (() => {
    try {
      return JSON.parse(b) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const chaves = new Set([...Object.keys(a), ...Object.keys(atual)]);
  return [...chaves].every((k) => JSON.stringify(a[k]) === JSON.stringify(atual[k]));
}

async function main() {
  const dry = process.argv.includes("--dry");
  const orgs = await db.organization.findMany({ select: { id: true, name: true } });
  if (!orgs.length) {
    console.log("nenhuma clínica no banco — nada a fazer.");
    return;
  }

  for (const org of orgs) {
    const existing = await db.automationRule.findMany({ where: { orgId: org.id } });
    console.log(`\n• ${org.name}`);

    for (const rule of DEFAULT_RULES) {
      const config = JSON.stringify(rule.config);
      const template = typeof rule.config.template === "string" ? rule.config.template : null;
      const achada = existing.find(
        (r) => r.event === rule.event && r.action === rule.action && templateDe(r.config) === template
      );

      if (!achada) {
        console.log(`  + ${rule.event} → ${rule.action} (${template ?? "-"})`);
        if (!dry) {
          await db.automationRule.create({ data: { orgId: org.id, event: rule.event, action: rule.action, config } });
        }
        continue;
      }

      if (!igual(rule.config, achada.config)) {
        console.log(`  ~ ${rule.event} → ${rule.action}: config ajustado para ${config}`);
        if (!dry) {
          await db.automationRule.update({ where: { id: achada.id }, data: { config } });
        }
      } else {
        console.log(`  ✓ ${rule.event} → ${rule.action} (${template ?? "-"}) já está igual`);
      }
    }

    // O lembrete de 24h que estava preso na confirmação: a criação do agendamento já o agenda,
    // e as duas regras juntas só serviriam para confundir na tela de Automações.
    const sobras = existing.filter(
      (r) => r.event === "appointment.confirmed" && r.action === "schedule_reminder" && templateDe(r.config) === "reminder_24h"
    );
    for (const sobra of sobras) {
      if (!sobra.enabled) continue;
      console.log(`  - desligada a regra antiga (lembrete 24h em "Agendamento confirmado")`);
      if (!dry) await db.automationRule.update({ where: { id: sobra.id }, data: { enabled: false } });
    }

    const templates = await db.messageTemplate.findMany({
      where: { orgId: org.id, key: { in: ["reminder_24h", "reminder_2h"] } },
      select: { key: true, name: true, enabled: true },
      orderBy: { key: "asc" },
    });
    for (const t of ["reminder_24h", "reminder_2h"]) {
      const template = templates.find((x) => x.key === t);
      if (!template) {
        console.log(`  ⚠ falta o template ${t} — o lembrete não tem o que enviar`);
      } else if (!template.enabled) {
        console.log(`  ⚠ o template "${template.name}" está desativado`);
      }
    }
  }

  console.log(dry ? "\(simulação — nada foi gravado)" : "\nok: regras aplicadas. O worker de jobs pega o que vence sozinho.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
