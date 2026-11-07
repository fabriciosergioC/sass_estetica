import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { setOptOut, listBlocked } from "@/modules/whatsapp/engagement";
import { blockNumber, unblockNumber } from "@/modules/whatsapp/queue";
import { toWhatsAppDigits } from "@/lib/phone";

/**
 * /api/whatsapp/blocked — lista de bloqueio e opt-out (§25).
 *
 * Bloqueio é sempre por barbearia, nunca global: um número que optou sair numa conta não é
 * proibido em outra. E opt-out é via `Customer.whatsappOptIn`, o mesmo campo que a automação
 * de lembretes respeita — uma decisão, um lugar.
 */

export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    return jsonOk({ items: await listBlocked(orgId) });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z
  .object({
    action: z.enum(["block", "unblock", "opt_out", "opt_in"]),
    phone: z.string().max(20).optional(),
    customerId: z.string().optional(),
    reason: z.enum(["opt_out", "spam", "manual", "invalid"]).default("manual"),
  })
  .refine((v) => Boolean(v.phone || v.customerId), { message: "Informe phone ou customerId." });

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    if (body.action === "opt_out" || body.action === "opt_in") {
      if (!body.customerId) return jsonOk({ error: "Opt-out exige customerId." }, 400);
      const result = await setOptOut(orgId, body.customerId, body.action === "opt_in");
      if (!result) return jsonOk({ error: "Cliente não encontrado." }, 404);
      return jsonOk(result);
    }

    const digits = toWhatsAppDigits(body.phone ?? "");
    if (!digits) return jsonOk({ error: "Número inválido." }, 400);

    if (body.action === "block") await blockNumber(orgId, digits, body.reason);
    else await unblockNumber(orgId, digits);

    return jsonOk({ action: body.action, phone: digits });
  } catch (err) {
    return handleApiError(err);
  }
}
