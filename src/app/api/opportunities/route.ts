import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { detectOpportunities } from "@/modules/intelligence/opportunities";

/** GET /api/opportunities?status=OPEN&type=... — oportunidades abertas da org. */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("opportunities:view");
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? "OPEN";
    const type = url.searchParams.get("type");
    const { skip, take, page, pageSize } = parsePagination(url);

    const where = {
      orgId,
      ...(status !== "ALL" ? { status } : {}),
      ...(type ? { type } : {}),
    };

    const [items, total] = await Promise.all([
      db.opportunity.findMany({
        where,
        orderBy: [{ priority: "desc" }, { detectedAt: "desc" }],
        skip,
        take,
      }),
      db.opportunity.count({ where }),
    ]);

    return jsonOk({ items, total, page, pageSize });
  } catch (err) {
    return handleApiError(err);
  }
}

const refreshSchema = z.object({ action: z.literal("refresh") });

/** POST /api/opportunities — { action: "refresh" } força nova detecção. */
export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("opportunities:view");
    refreshSchema.parse(await req.json());
    const created = await detectOpportunities(orgId);
    return jsonOk({ ok: true, created });
  } catch (err) {
    return handleApiError(err);
  }
}
