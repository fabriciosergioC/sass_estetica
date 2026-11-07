import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { createLabel, deleteLabel, listLabels } from "@/modules/whatsapp/engagement";

/**
 * /api/whatsapp/labels — etiquetas de atendimento (§22).
 * A primeira chamada cria as etiquetas padrão daquela barbearia; depois cada uma é editável.
 */

export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    return jsonOk({ items: await listLabels(orgId) });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.enum(["neutral", "gold", "green", "red", "blue", "amber"]).default("neutral"),
});

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());
    try {
      const label = await createLabel(orgId, body.name, body.color);
      return jsonOk({ label }, 201);
    } catch (err) {
      return jsonOk({ error: err instanceof Error ? err.message : "Não foi possível criar." }, 400);
    }
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE ?id= — remove a etiqueta e desanexa das conversas (relação tem cascade). */
export async function DELETE(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return jsonOk({ error: "Informe o id." }, 400);
    const ok = await deleteLabel(orgId, id);
    if (!ok) return jsonOk({ error: "Etiqueta não encontrada." }, 404);
    return jsonOk({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
