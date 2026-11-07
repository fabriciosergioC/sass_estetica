import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { toggleConversationLabel } from "@/modules/whatsapp/engagement";

/** POST /api/whatsapp/conversations/[id]/labels { labelId, on } — anexa/detacha etiqueta (§22). */
const schema = z.object({ labelId: z.string().min(1), on: z.boolean().default(true) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const { id } = await params;
    const body = schema.parse(await req.json());

    const result = await toggleConversationLabel(orgId, id, body.labelId, body.on);
    if (!result) return jsonOk({ error: "Conversa ou etiqueta não encontrada." }, 404);

    return jsonOk(result);
  } catch (err) {
    return handleApiError(err);
  }
}
