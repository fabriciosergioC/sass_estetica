// Endpoint de debug: lista e processa jobs pendentes manualmente.
// Útil quando o after() do Next não dispara em dev mode.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { processJobs } from "@/modules/automation/jobs";

/**
 * GET /api/whatsapp/_debug/jobs — lista os últimos 20 jobs e seus status.
 * POST /api/whatsapp/_debug/jobs — processa jobs pendentes manualmente.
 */
export async function GET(req: NextRequest) {
  try {
    await requirePermission("whatsapp:manage");
    const jobs = await db.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        runAt: true,
        processedAt: true,
        lastError: true,
        payload: true,
        createdAt: true,
        orgId: true,
      },
    });
    return jsonOk({ jobs });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = await req.json().catch(() => ({}));
    const limit = body.limit ?? 25;

    console.log(`[DEBUG] Processando jobs pendentes manualmente para orgId=${orgId}`);
    const processed = await processJobs(limit);
    console.log(`[DEBUG] processJobs returned=${processed}`);

    // Listar pendentes restantes para diagnóstico
    const pending = await db.job.findMany({
      where: { status: "PENDING", orgId },
      orderBy: { runAt: "asc" },
      take: 10,
      select: { id: true, type: true, attempts: true, lastError: true, runAt: true, payload: true },
    });

    return jsonOk({ processed, pending });
  } catch (err) {
    return handleApiError(err);
  }
}
