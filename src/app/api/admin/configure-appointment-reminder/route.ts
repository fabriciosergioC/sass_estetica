import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const expected = process.env.SUPABASE_MIGRATION_TOKEN;
  const authorization = req.headers.get("authorization") ?? "";
  if (!expected || authorization !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const organizations = await db.organization.findMany({ select: { id: true, name: true } });
  const result = await db.$transaction(async (tx) => {
    const updates: Array<{ organization: string; disabledRules: number; cancelledMessages: number }> = [];

    for (const organization of organizations) {
      const rules = await tx.automationRule.findMany({
        where: { orgId: organization.id },
        select: { id: true, action: true, config: true },
      });
      let disabledRules = 0;
      for (const rule of rules) {
        let config: { template?: string } = {};
        try { config = JSON.parse(rule.config || "{}"); } catch {}
        if (
          (rule.action === "send_whatsapp" && config.template === "confirmation") ||
          (rule.action === "schedule_reminder" && config.template === "reminder_2h")
        ) {
          await tx.automationRule.update({ where: { id: rule.id }, data: { enabled: false } });
          disabledRules++;
        }
      }

      await tx.messageTemplate.updateMany({
        where: { orgId: organization.id, key: "confirmation" },
        data: {
          name: "Confirmação de agendamento",
          body: "Olá, {{cliente}}! Seu horário está confirmado: {{servico}} com {{barbeiro}} em {{data}} às {{hora}} na {{barbearia}}. Até logo! ✨",
        },
      });
      await tx.messageTemplate.updateMany({
        where: { orgId: organization.id, key: "reminder_24h" },
        data: {
          name: "Lembrete 24h antes",
          body: "Olá, {{cliente}}! Lembrete: seu horário na {{barbearia}} é amanhã, {{data}} às {{hora}}, com {{barbeiro}}. Confirma presença? Responda SIM para confirmar.",
        },
      });

      const scheduleRules = await tx.automationRule.findMany({
        where: { orgId: organization.id, event: "appointment.created", action: "schedule_reminder" },
        select: { id: true, config: true },
      });
      const existing24h = scheduleRules.find((rule) => {
        try { return JSON.parse(rule.config || "{}").template === "reminder_24h"; } catch { return false; }
      });
      if (existing24h) {
        await tx.automationRule.update({ where: { id: existing24h.id }, data: { enabled: true, config: JSON.stringify({ template: "reminder_24h", hoursBefore: 24 }) } });
      } else {
        await tx.automationRule.create({ data: { orgId: organization.id, event: "appointment.created", action: "schedule_reminder", config: JSON.stringify({ template: "reminder_24h", hoursBefore: 24 }), enabled: true } });
      }

      const cancelledMessages = await tx.whatsAppMessage.updateMany({
        where: { orgId: organization.id, status: "QUEUED", templateKey: { in: ["confirmation", "reminder_2h"] } },
        data: { status: "CANCELLED", error: "Desativado: somente reminder_24h deve ser enviado após agendamento." },
      });
      updates.push({ organization: organization.name, disabledRules, cancelledMessages: cancelledMessages.count });
    }

    return updates;
  });

  return NextResponse.json({ ok: true, organizations: organizations.length, result });
}
