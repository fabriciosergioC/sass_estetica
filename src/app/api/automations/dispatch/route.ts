import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { formatDateTimeBR } from "@/modules/whatsapp/messages";
import { sendMessage } from "@/modules/whatsapp/service";

const dispatchSchema = z.object({
  templateKey: z.string().optional(),
  ruleId: z.string().optional(),
  customerId: z.string().min(1, "Selecione o cliente."),
  customBody: z.string().optional(),
  appointmentId: z.string().optional(),
});

/**
 * POST /api/automations/dispatch — disparo manual de automação/template para um cliente.
 */
export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("automations:manage");
    const body = dispatchSchema.parse(await req.json());

    // 1. Busca cliente
    const customer = await db.customer.findFirst({
      where: { id: body.customerId, orgId },
      select: { id: true, name: true, phone: true, whatsappOptIn: true },
    });
    if (!customer) {
      return jsonOk({ error: "Cliente não encontrado." }, 404);
    }
    if (!customer.phone) {
      return jsonOk({ error: "Cliente não possui telefone cadastrado." }, 400);
    }
    if (customer.whatsappOptIn === false) {
      return jsonOk({ error: `${customer.name} marcou opção de não receber mensagens (opt-out).` }, 400);
    }

    // 2. Determina template e regra
    let rule = null;
    let templateKey = body.templateKey;
    if (body.ruleId) {
      rule = await db.automationRule.findFirst({ where: { id: body.ruleId, orgId } });
      if (rule) {
        try {
          const cfg = JSON.parse(rule.config || "{}");
          if (cfg.template && !templateKey) templateKey = cfg.template;
        } catch {}
      }
    }

    let template = null;
    if (templateKey) {
      template = await db.messageTemplate.findUnique({
        where: { orgId_key: { orgId, key: templateKey } },
      });
    }

    const messageBody = body.customBody?.trim() || template?.body;
    if (!messageBody) {
      return jsonOk({ error: "Texto da mensagem não informado ou template inexistente." }, 400);
    }

    // 3. Busca agendamento recente para preencher variáveis adicionais (servico, barbeiro, data, hora)
    const appt = body.appointmentId
      ? await db.appointment.findFirst({
          where: { id: body.appointmentId, orgId },
          include: { barber: { select: { name: true } }, service: { select: { name: true } } },
        })
      : await db.appointment.findFirst({
          where: { customerId: customer.id, orgId },
          orderBy: { startAt: "desc" },
          include: { barber: { select: { name: true } }, service: { select: { name: true } } },
        });

    const extra: Record<string, string> = {};
    if (appt) {
      extra.servico = appt.service?.name ?? "";
      extra.barbeiro = appt.barber?.name ?? "";
      if (appt.startAt) {
        const { data, hora } = formatDateTimeBR(appt.startAt);
        extra.data = data;
        extra.hora = hora;
      }
    }

    // 4. Dispara mensagem imediata
    const outcome = await sendMessage({
      orgId,
      phone: customer.phone,
      customerId: customer.id,
      appointmentId: appt?.id,
      body: messageBody,
      templateKey: template?.key ?? templateKey ?? null,
      userId: session.userId,
      extra,
      immediate: true,
    });

    // 5. Registra a execução no histórico de automações
    const eventName = rule?.event ?? (templateKey ? `template.${templateKey}` : "manual.dispatch");
    await db.automationExecution.create({
      data: {
        orgId,
        ruleId: rule?.id ?? null,
        event: `${eventName} (manual)`,
        payload: JSON.stringify({
          customerId: customer.id,
          customerName: customer.name,
          phone: customer.phone,
          appointmentId: appt?.id,
          manual: true,
          userId: session.userId,
        }),
        status: outcome.ok ? "SUCCESS" : "FAILED",
        error: outcome.ok ? null : (outcome.friendly ?? outcome.error ?? "Falha no envio"),
      },
    });

    return jsonOk({
      ok: outcome.ok,
      status: outcome.status,
      friendly: outcome.friendly,
      error: outcome.error,
      messageId: outcome.messageId,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
