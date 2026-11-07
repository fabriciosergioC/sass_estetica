import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const createSchema = z.object({
  name: z.string().min(2).max(80),
  bio: z.string().max(300).optional(),
  specialties: z.string().max(200).default(""),
  commissionPct: z.coerce.number().int().min(0).max(100).default(0),
  active: z.boolean().default(true),
  serviceIds: z.array(z.string()).default([]),
});

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("team:manage");
    const url = new URL(req.url);
    const { skip, take, page } = parsePagination(url);

    const [items, total] = await Promise.all([
      db.barber.findMany({
        where: { orgId },
        orderBy: [{ active: "desc" }, { name: "asc" }],
        skip,
        take,
        include: { services: { include: { service: true } } },
      }),
      db.barber.count({ where: { orgId } }),
    ]);

    return jsonOk({
      items: items.map((b) => ({
        ...b,
        services: b.services.map((bs) => bs.service),
      })),
      total,
      page,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("team:manage");
    const body = createSchema.parse(await req.json());

    const barber = await db.barber.create({
      data: {
        orgId,
        name: body.name,
        bio: body.bio,
        specialties: body.specialties,
        commissionPct: body.commissionPct,
        active: body.active,
        services: {
          create: body.serviceIds.map((serviceId) => ({
            service: { connect: { id: serviceId } },
          })),
        },
      },
    });

    return jsonOk({ barber }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
