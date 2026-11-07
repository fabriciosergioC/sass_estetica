import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { containsCI } from "@/lib/search";
import { requirePermission } from "@/lib/auth/guards";

const createSchema = z.object({
  name: z.string().min(2, "Nome muito curto").max(80),
  description: z.string().max(500).optional(),
  durationMin: z.coerce.number().int().min(5, "Duração mínima: 5 min").max(480),
  priceCents: z.coerce.number().int().min(0),
  category: z.string().max(40).default("GERAL"),
  active: z.boolean().default(true),
});

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("services:manage");
    const url = new URL(req.url);
    const { skip, take, page } = parsePagination(url);
    const q = url.searchParams.get("q");

    const where = {
      orgId,
      ...(q ? { name: containsCI(q) } : {}),
    };

    const [items, total] = await Promise.all([
      db.service.findMany({ where, orderBy: [{ active: "desc" }, { name: "asc" }], skip, take }),
      db.service.count({ where }),
    ]);

    return jsonOk({ items, total, page });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("services:manage");
    const body = createSchema.parse(await req.json());

    const service = await db.service.create({ data: { ...body, orgId } });
    return jsonOk({ service }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
