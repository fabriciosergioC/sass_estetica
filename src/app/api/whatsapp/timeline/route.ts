import { NextRequest } from "next/server";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { customerTimeline } from "@/modules/whatsapp/inbox";

/**
 * GET /api/whatsapp/timeline?customerId= — a linha do tempo do lead (§10).
 *
 * É montagem por leitura, não tabela nova: cadastro, mensagens, observações, follow-ups e
 * etiquetas já existem; copiar isso para uma `timeline` seria ter dois históricos capazes de
 * discordar um do outro.
 */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId");
    if (!customerId) return jsonOk({ error: "Informe customerId." }, 400);

    const limit = Math.min(120, Number(url.searchParams.get("limit") ?? 60) || 60);
    return jsonOk({ items: await customerTimeline(orgId, customerId, limit) });
  } catch (err) {
    return handleApiError(err);
  }
}
