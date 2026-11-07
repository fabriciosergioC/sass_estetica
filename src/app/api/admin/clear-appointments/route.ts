import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const expected = process.env.SUPABASE_MIGRATION_TOKEN;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { organizationName?: string };
  const organizationName = body.organizationName?.trim();
  if (!organizationName) {
    return NextResponse.json({ error: "organizationName é obrigatório" }, { status: 400 });
  }

  const organization = await db.organization.findFirst({
    where: { name: { equals: organizationName, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!organization) {
    return NextResponse.json({ error: "Organização não encontrada" }, { status: 404 });
  }

  const result = await db.$transaction(async (tx) => {
    const appointmentIds = await tx.appointment.findMany({
      where: { orgId: organization.id },
      select: { id: true },
    });
    const ids = appointmentIds.map((item) => item.id);

    const history = await tx.appointmentStatusHistory.deleteMany({
      where: { appointmentId: { in: ids } },
    });
    await tx.payment.deleteMany({ where: { orgId: organization.id } });
    const whatsappMedia = await tx.whatsAppMedia.deleteMany({ where: { orgId: organization.id } });
    const whatsappMessages = await tx.whatsAppMessage.deleteMany({ where: { orgId: organization.id } });
    await tx.whatsAppFollowUp.deleteMany({ where: { orgId: organization.id } });
    const whatsappConversations = await tx.whatsAppConversation.deleteMany({ where: { orgId: organization.id } });
    const whatsappContacts = await tx.whatsAppContact.deleteMany({ where: { orgId: organization.id } });
    const whatsappLogs = await tx.whatsAppLog.deleteMany({ where: { orgId: organization.id } });
    const automationExecutions = await tx.automationExecution.deleteMany({ where: { orgId: organization.id } });
    const whatsappJobs = await tx.job.deleteMany({ where: { orgId: organization.id, type: "send_whatsapp" } });
    const appointments = await tx.appointment.deleteMany({ where: { orgId: organization.id } });

    return {
      historyDeleted: history.count,
      appointmentsDeleted: appointments.count,
      whatsappMediaDeleted: whatsappMedia.count,
      whatsappMessagesDeleted: whatsappMessages.count,
      whatsappConversationsDeleted: whatsappConversations.count,
      whatsappContactsDeleted: whatsappContacts.count,
      whatsappLogsDeleted: whatsappLogs.count,
      automationExecutionsDeleted: automationExecutions.count,
      whatsappJobsDeleted: whatsappJobs.count,
    };
  });

  return NextResponse.json({ ok: true, organization, ...result });
}
