import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const putSchema = z.object({
  key: z.string().min(1),
  body: z.string().min(10, "Mensagem muito curta.").max(1000),
  enabled: z.boolean().optional(),
});

/** PUT /api/automations/templates — edita um template de mensagem. */
export async function PUT(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("automations:manage");
    const body = putSchema.parse(await req.json());

    const template = await db.messageTemplate.findUnique({
      where: { orgId_key: { orgId, key: body.key } },
    });
    if (!template) return jsonOk({ error: "Template não encontrado." }, 404);

    const updated = await db.messageTemplate.update({
      where: { id: template.id },
      data: { body: body.body, enabled: body.enabled ?? template.enabled },
    });
    await db.auditLog.create({
      data: {
        orgId,
        userId: session.userId,
        action: "template.update",
        entity: "message_template",
        entityId: template.id,
        before: JSON.stringify({ body: template.body, enabled: template.enabled }),
        after: JSON.stringify({ body: updated.body, enabled: updated.enabled }),
      },
    });
    return jsonOk({ template: updated });
  } catch (err) {
    return handleApiError(err);
  }
}
