import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:MM)");

const hourSchema = z.object({
  weekday: z.coerce.number().int().min(0).max(6),
  closed: z.boolean(),
  openTime: TIME.optional(),
  closeTime: TIME.optional(),
  breakStart: TIME.nullable().optional(),
  breakEnd: TIME.nullable().optional(),
});

/** GET /api/business-hours?barberId=... — retorna os 7 dias (barbeiro ou padrão da org). */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("appointments:read");
    const url = new URL(req.url);
    const barberId = url.searchParams.get("barberId");

    if (barberId) {
      const barber = await db.barber.findFirst({ where: { id: barberId, orgId } });
      if (!barber) return jsonOk({ error: "Barbeiro não encontrado." }, 404);
    }

    const rows = await db.businessHour.findMany({
      where: { orgId, barberId: barberId ?? null },
      orderBy: { weekday: "asc" },
    });

    // Garante os 7 dias na resposta mesmo se faltar registro
    const hours = Array.from({ length: 7 }, (_, weekday) => {
      const found = rows.find((r) => r.weekday === weekday);
      return (
        found ?? {
          weekday,
          closed: weekday === 0,
          openTime: "09:00",
          closeTime: weekday === 6 ? "20:00" : "19:00",
          breakStart: null,
          breakEnd: null,
        }
      );
    });

    const response = jsonOk({ hours });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}

const putSchema = z.object({
  barberId: z.string().optional(), // ausente = padrão da organização
  hours: z
    .array(hourSchema)
    .length(7)
    .refine((hours) => new Set(hours.map((h) => h.weekday)).size === 7, "Envie cada dia da semana exatamente uma vez."),
});

export async function PUT(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("schedule:manage");
    const body = putSchema.parse(await req.json());

    if (body.barberId) {
      const barber = await db.barber.findFirst({ where: { id: body.barberId, orgId } });
      if (!barber) return jsonOk({ error: "Barbeiro não encontrado." }, 404);
    }

    for (const h of body.hours) {
      if (!h.closed) {
        if (!h.openTime || !h.closeTime) return jsonOk({ error: "Informe abertura e fechamento nos dias abertos." }, 400);
        if (h.openTime >= h.closeTime) return jsonOk({ error: `Dia ${h.weekday}: abertura deve ser antes do fechamento.` }, 400);
        if ((h.breakStart && !h.breakEnd) || (!h.breakStart && h.breakEnd)) {
          return jsonOk({ error: `Dia ${h.weekday}: intervalo precisa ter início e fim.` }, 400);
        }
        if (h.breakStart && h.breakEnd && h.breakStart >= h.breakEnd) {
          return jsonOk({ error: `Dia ${h.weekday}: início do intervalo deve ser antes do fim.` }, 400);
        }
        if (h.breakStart && h.breakEnd && !(h.breakStart >= h.openTime && h.breakEnd <= h.closeTime)) {
          return jsonOk({ error: `Dia ${h.weekday}: intervalo fora do horário de funcionamento.` }, 400);
        }
      }
    }

    await db.$transaction(async (tx) => {
      // Recria os 7 dias dentro da transação: evita duplicatas quando barberId é
      // NULL (o unique composto do PostgreSQL não cobre NULL como se espera).
      await tx.businessHour.deleteMany({ where: { orgId, barberId: body.barberId ?? null } });
      await tx.businessHour.createMany({
        data: body.hours.map((h) => ({
          orgId,
          barberId: body.barberId ?? null,
          weekday: h.weekday,
          closed: h.closed,
          openTime: h.openTime ?? "09:00",
          closeTime: h.closeTime ?? "19:00",
          breakStart: h.breakStart ?? null,
          breakEnd: h.breakEnd ?? null,
        })),
      });
      await tx.auditLog.create({
        data: {
          orgId,
          userId: session.userId,
          action: "business_hours.update",
          entity: "business_hour",
          entityId: body.barberId ?? "org-default",
          after: JSON.stringify(body.hours),
        },
      });
    });

    const response = jsonOk({ ok: true, hours: body.hours });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
