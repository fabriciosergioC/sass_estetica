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

    const history = await tx.appointmentStatusHistory.deleteMany({
      where: { appointmentId: { in: appointmentIds.map((item) => item.id) } },
    });
    const appointments = await tx.appointment.deleteMany({ where: { orgId: organization.id } });

    return { historyDeleted: history.count, appointmentsDeleted: appointments.count };
  });

  return NextResponse.json({ ok: true, organization, ...result });
}
