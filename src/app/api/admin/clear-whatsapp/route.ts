import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const expected = process.env.SUPABASE_MIGRATION_TOKEN;
  const authorization = req.headers.get("authorization") ?? "";
  if (!expected || (authorization !== `Bearer ${expected}` && authorization !== expected)) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { organizationName?: string };
  const organizationName = body.organizationName?.trim() || "Bela Face";
  const organization = await db.organization.findFirst({
    where: { name: { equals: organizationName, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!organization) return NextResponse.json({ error: "Organização não encontrada" }, { status: 404 });

  const result = await db.$transaction(async (tx) => {
    const media = await tx.whatsAppMedia.deleteMany({ where: { orgId: organization.id } });
    const messages = await tx.whatsAppMessage.deleteMany({ where: { orgId: organization.id } });
    await tx.whatsAppFollowUp.deleteMany({ where: { orgId: organization.id } });
    const conversations = await tx.whatsAppConversation.deleteMany({ where: { orgId: organization.id } });
    const contacts = await tx.whatsAppContact.deleteMany({ where: { orgId: organization.id } });
    const logs = await tx.whatsAppLog.deleteMany({ where: { orgId: organization.id } });
    const executions = await tx.automationExecution.deleteMany({ where: { orgId: organization.id } });
    const jobs = await tx.job.deleteMany({ where: { orgId: organization.id, type: "send_whatsapp" } });

    return {
      whatsappMediaDeleted: media.count,
      whatsappMessagesDeleted: messages.count,
      whatsappConversationsDeleted: conversations.count,
      whatsappContactsDeleted: contacts.count,
      whatsappLogsDeleted: logs.count,
      automationExecutionsDeleted: executions.count,
      whatsappJobsDeleted: jobs.count,
    };
  });

  return NextResponse.json({ ok: true, organization, ...result });
}
