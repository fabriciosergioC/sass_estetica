import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { processJobs } from "@/modules/automation/jobs";
import { detectOpportunities } from "@/modules/intelligence/opportunities";

/**
 * POST /api/cron — worker agendado.
 * Protegido por CRON_SECRET (header x-cron-secret).
 * Processa jobs vencidos (lembretes, envios) e roda os detectores de oportunidades.
 * Em produção, agende com um cron job / Vercel Cron chamando esta rota.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get("x-cron-secret");
  if (!secret || provided !== secret) {
    return jsonOk({ error: "Não autorizado." }, 401);
  }

  const processed = await processJobs(50);

  const orgs = await db.organization.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
    take: 100,
  });
  let created = 0;
  for (const org of orgs) {
    created += await detectOpportunities(org.id);
  }

  return jsonOk({ ok: true, processed, opportunitiesCreated: created });
}

/** GET também aceito para facilitar testes manuais com ?secret= */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret");
  if (!secret || provided !== secret) return jsonOk({ error: "Não autorizado." }, 401);
  return POST(req);
}
