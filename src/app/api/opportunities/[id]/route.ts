import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { sendTemplateMessage, type TemplateKey } from "@/modules/whatsapp/messages";

const patchSchema = z.object({
  status: z.enum(["DISMISSED", "ACTION_TAKEN", "OPEN"]),
});

/** PATCH /api/opportunities/[id] — descartar ou marcar como aproveitada. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("opportunities:view");
    const { id } = await params;
    const body = patchSchema.parse(await req.json());

    const opportunity = await db.opportunity.findFirst({ where: { id, orgId } });
    if (!opportunity) return jsonOk({ error: "Oportunidade não encontrada." }, 404);

    const updated = await db.opportunity.update({
      where: { id: opportunity.id },
      data: {
        status: body.status,
        resolvedAt: body.status === "OPEN" ? null : new Date(),
      },
    });

    await db.auditLog.create({
      data: {
        orgId,
        userId: session.userId,
        action: `opportunity.${body.status.toLowerCase()}`,
        entity: "opportunity",
        entityId: opportunity.id,
        before: JSON.stringify({ status: opportunity.status }),
        after: JSON.stringify({ status: body.status }),
      },
    });

    return jsonOk({ opportunity: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

const actionSchema = z.object({
  type: z.enum(["send_whatsapp", "recover_slot"]),
  /** Para send_whatsapp: alvo opcional (padrão: cliente da oportunidade). */
  customerId: z.string().optional(),
  phone: z.string().optional(),
});

/** POST /api/opportunities/[id]/actions — executa a ação sugerida de verdade. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("opportunities:view");
    const { id } = await params;
    const body = actionSchema.parse(await req.json());

    const opportunity = await db.opportunity.findFirst({ where: { id, orgId } });
    if (!opportunity) return jsonOk({ error: "Oportunidade não encontrada." }, 404);

    const payload = JSON.parse(opportunity.actionPayload || "{}") as {
      template?: string;
      customerId?: string;
      appointmentId?: string;
    };

    let result = "";
    if (body.type === "send_whatsapp") {
      const customerId = body.customerId ?? payload.customerId;
      const sent = await sendTemplateMessage({
        orgId,
        templateKey: (payload.template ?? "return_due") as TemplateKey,
        vars: { customerId, phone: body.phone, appointmentId: payload.appointmentId },
        dedupeKey: `opp:${opportunity.id}:${customerId ?? body.phone ?? "n/a"}`,
      });
      if (!sent) {
        return jsonOk(
          { error: "Cliente sem consentimento de WhatsApp ou mensagem indisponível." },
          400
        );
      }
      result = "Mensagem enfileirada.";
    } else if (body.type === "recover_slot") {
      const sent = await sendTemplateMessage({
        orgId,
        templateKey: "slot_recovery",
        vars: { customerId: payload.customerId, appointmentId: payload.appointmentId },
        extra: {
          hora:
            typeof (payload as { slot?: { time?: string } }).slot?.time === "string"
              ? (payload as { slot?: { time?: string } }).slot!.time!
              : "",
        },
        dedupeKey: `recover:${opportunity.id}`,
      });
      if (!sent) {
        return jsonOk({ error: "Não foi possível enfileirar a mensagem." }, 400);
      }
      result = "Mensagem de recuperação enfileirada.";
    }

    const action = await db.opportunityAction.create({
      data: {
        opportunityId: opportunity.id,
        type: body.type,
        payload: JSON.stringify(body),
        result,
      },
    });
    await db.opportunity.update({
      where: { id: opportunity.id },
      data: { status: "ACTION_TAKEN", resolvedAt: new Date() },
    });
    await db.auditLog.create({
      data: {
        orgId,
        userId: session.userId,
        action: "opportunity.action",
        entity: "opportunity",
        entityId: opportunity.id,
        after: JSON.stringify({ type: body.type, result }),
      },
    });

    return jsonOk({ ok: true, action, result });
  } catch (err) {
    return handleApiError(err);
  }
}
