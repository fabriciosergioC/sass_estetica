import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
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

    const updated = await db.automationRule.update({
      where: { id: rule.id },
      data: { enabled: body.enabled },
    });
    await db.auditLog.create({
      data: {
        orgId,
        userId: session.userId,
        action: `automation.${body.enabled ? "enable" : "disable"}`,
        entity: "automation_rule",
        entityId: rule.id,
        before: JSON.stringify({ enabled: rule.enabled }),
        after: JSON.stringify({ enabled: body.enabled }),
      },
    });
    return jsonOk({ rule: { ...updated, config: JSON.parse(updated.config || "{}") } });
  } catch (err) {
    return handleApiError(err);
  }
}
