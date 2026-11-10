import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { isFixedNoticeRule, isLegacyConfirmedReminder, ruleTemplate } from "@/modules/automation/rules";
import { DEFAULT_RULES, DEFAULT_TEMPLATES } from "@/modules/organizations/service";

/** GET /api/automations — regras, templates e execuções recentes da org. */
export async function GET() {
  try {
    const { orgId } = await requirePermission("automations:manage");
    const existingRules = await db.automationRule.findMany({ where: { orgId } });
    for (const rule of DEFAULT_RULES) {
      const defaultConfig = JSON.stringify(rule.config);
      const defaultTemplate = typeof rule.config.template === "string" ? rule.config.template : null;
      const exists = existingRules.some((current) => {
        if (current.event !== rule.event || current.action !== rule.action) return false;
        try {
          const currentConfig = JSON.parse(current.config || "{}") as { template?: string };
          return currentConfig.template === defaultTemplate;
        } catch {
          return false;
        }
      });
      if (!exists) {
        await db.automationRule.create({
          data: { orgId, event: rule.event, action: rule.action, config: defaultConfig },
        });
      }
    }

    // Legado: o lembrete de 24h que ficava preso em "Agendamento confirmado". O par fixo já
    // agenda o lembrete na criação; deixar esta ligada faria o cliente receber mensagem mesmo
    // com o interruptor do menu desligado. Desligamos (sem apagar) para manter o histórico.
    const legacyRules = await db.automationRule.findMany({
      where: { orgId, event: "appointment.confirmed", action: "schedule_reminder", enabled: true },
    });
    for (const legacy of legacyRules) {
      if (isLegacyConfirmedReminder(legacy)) {
        await db.automationRule.update({ where: { id: legacy.id }, data: { enabled: false } });
      }
    }

    const existingTemplates = await db.messageTemplate.findMany({ where: { orgId } });
    for (const template of DEFAULT_TEMPLATES) {
      if (!existingTemplates.some((current) => current.key === template.key)) {
        await db.messageTemplate.create({ data: { orgId, ...template } });
      }
    }

    const [rules, templates, executions] = await Promise.all([
      db.automationRule.findMany({ where: { orgId }, orderBy: [{ event: "asc" }, { createdAt: "asc" }] }),
      db.messageTemplate.findMany({ where: { orgId }, orderBy: [{ key: "asc" }] }),
      db.automationExecution.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
    return jsonOk({
      rules: rules.map((r) => ({ ...r, config: JSON.parse(r.config || "{}") })),
      templates,
      executions,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
});

/** PATCH /api/automations — liga/desliga uma regra. */
export async function PATCH(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("automations:manage");
    const body = patchSchema.parse(await req.json());

    const rule = await db.automationRule.findFirst({ where: { id: body.id, orgId } });
    if (!rule) return jsonOk({ error: "Regra não encontrada." }, 404);

    // O bloco "Mensagem de agendamento" da tela é um interruptor só. Ligar/desligar qualquer
    // uma das duas regras do par (confirmação do mesmo dia e lembrete de 24h) vale para as duas,
    // senão a lógica fixa ficaria pela metade — e o cliente ou nunca receberia nada, ou
    // receberia as duas mensagens.
    let targets = [rule];
    if (isFixedNoticeRule(rule)) {
      const orgRules = await db.automationRule.findMany({ where: { orgId, event: rule.event } });
      targets = orgRules.filter(isFixedNoticeRule);

      // Org que ainda não tinha o par completo: cria a regra que falta já com o estado pedido.
      // Sem isto o GET da tela recriaria a faltante ligada, e o interruptor mentiria.
      const noticeDefaults = DEFAULT_RULES.filter(isFixedNoticeRule);
      for (const fallback of noticeDefaults) {
        const exists = orgRules.some(
          (current) =>
            current.action === fallback.action &&
            ruleTemplate(current.config) === ruleTemplate(fallback.config)
        );
        if (!exists) {
          const created = await db.automationRule.create({
            data: {
              orgId,
              event: fallback.event,
              action: fallback.action,
              config: JSON.stringify(fallback.config),
              enabled: body.enabled,
            },
          });
          targets.push(created);
        }
      }
    }

    await db.$transaction(async (tx) => {
      await tx.automationRule.updateMany({
        where: { id: { in: targets.map((target) => target.id) } },
        data: { enabled: body.enabled },
      });
      for (const target of targets) {
        await tx.auditLog.create({
          data: {
            orgId,
            userId: session.userId,
            action: `automation.${body.enabled ? "enable" : "disable"}`,
            entity: "automation_rule",
            entityId: target.id,
            before: JSON.stringify({ enabled: target.enabled }),
            after: JSON.stringify({ enabled: body.enabled }),
          },
        });
      }
    });

    const updated = await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } });
    return jsonOk({ rule: { ...updated, config: JSON.parse(updated.config || "{}") } });
  } catch (err) {
    return handleApiError(err);
  }
}
