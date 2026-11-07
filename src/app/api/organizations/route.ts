import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession, setSessionCookie } from "@/lib/auth/session";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida (use #rrggbb).");

const patchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  phone: z.string().max(20).nullable().optional(),
  whatsapp: z.string().max(20).nullable().optional(),
  address: z.string().max(160).nullable().optional(),
  city: z.string().max(80).nullable().optional(),
  state: z.string().max(2).nullable().optional(),
  instagram: z.string().max(60).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  primaryColor: HEX.optional(),
  timezone: z.string().max(60).optional(),
  slotStepMin: z.coerce.number().int().min(5).max(120).optional(),
  /** Configurações de agendamento público. */
  settings: z
    .object({
      advanceDays: z.coerce.number().int().min(1).max(60).optional(),
      minHoursAhead: z.coerce.number().int().min(0).max(72).optional(),
      allowSameDay: z.boolean().optional(),
    })
    .optional(),
});

/** GET /api/organizations — dados da organização ativa. */
export async function GET() {
  try {
    const { orgId } = await requirePermission("org:manage");
    const org = await db.organization.findUnique({
      where: { id: orgId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!org) return jsonOk({ error: "Organização não encontrada." }, 404);
    const { settings, ...rest } = org;
    return jsonOk({
      organization: { ...rest, settings: JSON.parse(settings || "{}") },
      plan: org.subscription?.plan ?? null,
      subscription: org.subscription,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/** PATCH /api/organizations — atualiza configurações da barbearia. */
export async function PATCH(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("org:manage");
    const body = patchSchema.parse(await req.json());

    const current = await db.organization.findUnique({ where: { id: orgId } });
    if (!current) return jsonOk({ error: "Organização não encontrada." }, 404);

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "settings") continue;
      if (value !== undefined) data[key] = value;
    }
    let settings = JSON.parse(current.settings || "{}");
    if (body.settings) settings = { ...settings, ...body.settings };

    const updated = await db.organization.update({
      where: { id: orgId },
      data: { ...data, settings: JSON.stringify(settings) },
    });

    // Atualizar o cachedOrgName na sessão, se for a organização ativa
    const currentSession = await getSession();
    if (currentSession && currentSession.activeOrgId === orgId) {
      await setSessionCookie({
        ...currentSession,
        cachedOrgName: updated.name,
      });
    }

    await db.auditLog.create({
      data: {
        orgId,
        userId: session.userId,
        action: "org.update",
        entity: "organization",
        entityId: orgId,
        before: JSON.stringify({ name: current.name, phone: current.phone, primaryColor: current.primaryColor }),
        after: JSON.stringify({ name: updated.name, phone: updated.phone, primaryColor: updated.primaryColor }),
      },
    });

    const { settings: s, ...rest } = updated;
    return jsonOk({ organization: { ...rest, settings: JSON.parse(s || "{}") } });
  } catch (err) {
    return handleApiError(err);
  }
}
