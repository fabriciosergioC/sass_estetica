import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

/** GET /api/notifications?unread=1 — central de notificações da org. */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("appointments:read");
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get("unread") === "1";
    const { skip, take, page, pageSize } = parsePagination(url);

    const where = { orgId, ...(unreadOnly ? { read: false } : {}) };
    const [items, total, unread] = await Promise.all([
      db.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      db.notification.count({ where }),
      db.notification.count({ where: { orgId, read: false } }),
    ]);
    return jsonOk({ items, total, unread, page, pageSize });
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z.object({
  /** id específico ou "all" */
  id: z.string().min(1),
});

/** PATCH /api/notifications — marca como lida (id ou "all"). */
export async function PATCH(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("appointments:read");
    const body = patchSchema.parse(await req.json());

    if (body.id === "all") {
      await db.notification.updateMany({ where: { orgId, read: false }, data: { read: true } });
      return jsonOk({ ok: true });
    }
    const updated = await db.notification.updateMany({
      where: { id: body.id, orgId },
      data: { read: true },
    });
    if (updated.count === 0) return jsonOk({ error: "Notificação não encontrada." }, 404);
    return jsonOk({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
