import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const updateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional(),
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  priceCents: z.coerce.number().int().min(0).optional(),
  category: z.string().max(40).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("services:manage");
    const { id } = await params;
    const body = updateSchema.parse(await req.json());

    const existing = await db.service.findFirst({ where: { id, orgId } });
    if (!existing) return jsonOk({ error: "Serviço não encontrado." }, 404);

    const service = await db.$transaction(async (tx) => {
      const updated = await tx.service.update({ where: { id }, data: body });
      await tx.auditLog.create({
        data: {
          orgId,
          userId: session.userId,
          action: "service.update",
          entity: "service",
          entityId: id,
          before: JSON.stringify(existing),
          after: JSON.stringify(updated),
        },
      });
      return updated;
    });

    return jsonOk({ service });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("services:manage");
    const { id } = await params;

    const existing = await db.service.findFirst({ where: { id, orgId } });
    if (!existing) return jsonOk({ error: "Serviço não encontrado." }, 404);

    const inUse = await db.appointment.count({ where: { serviceId: id } });
    if (inUse > 0) {
      // Histórico preservado: desativa em vez de apagar
      await db.service.update({ where: { id }, data: { active: false } });
      return jsonOk({ ok: true, deactivated: true });
    }

    await db.$transaction(async (tx) => {
      await tx.service.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          orgId,
          userId: session.userId,
          action: "service.delete",
          entity: "service",
          entityId: id,
          before: JSON.stringify(existing),
        },
      });
    });

    return jsonOk({ ok: true, deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
