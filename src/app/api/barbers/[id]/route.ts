import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const updateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  bio: z.string().max(300).optional(),
  specialties: z.string().max(200).optional(),
  commissionPct: z.coerce.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
  serviceIds: z.array(z.string()).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("team:manage");
    const { id } = await params;
    const body = updateSchema.parse(await req.json());

    const existing = await db.barber.findFirst({ where: { id, orgId } });
    if (!existing) return jsonOk({ error: "Barbeiro não encontrado." }, 404);

    const { serviceIds, ...data } = body;

    const barber = await db.$transaction(async (tx) => {
      const updated = await tx.barber.update({ where: { id }, data });

      if (serviceIds) {
        await tx.barberService.deleteMany({ where: { barberId: id, serviceId: { notIn: serviceIds } } });
        const current = await tx.barberService.findMany({ where: { barberId: id } });
        const toAdd = serviceIds.filter((sid) => !current.some((bs) => bs.serviceId === sid));
        await tx.barberService.createMany({
          data: toAdd.map((serviceId) => ({ barberId: id, serviceId })),
        });
      }

      return tx.barber.findFirstOrThrow({
        where: { id },
        include: { services: { include: { service: true } } },
      });
    });

    return jsonOk({
      barber: { ...barber, services: barber.services.map((bs) => bs.service) },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("team:manage");
    const { id } = await params;

    const existing = await db.barber.findFirst({ where: { id, orgId } });
    if (!existing) return jsonOk({ error: "Barbeiro não encontrado." }, 404);

    const inUse = await db.appointment.count({ where: { barberId: id } });
    if (inUse > 0) {
      await db.barber.update({ where: { id }, data: { active: false } });
      return jsonOk({ ok: true, deactivated: true });
    }

    await db.barber.delete({ where: { id } });
    return jsonOk({ ok: true, deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
