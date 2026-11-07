import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { connect, currentQr } from "@/modules/whatsapp/service";

/**
 * /api/whatsapp/qr — o QR Code do pareamento (§3).
 *
 * O QR mora na memória do processo que dono do socket; a rota só o lê e converte em PNG
 * base64 (o adapter já faz isso). Nada de QR no banco nem em log: ele é credencial temporária.
 */

/** GET — QR atual, idade e motivo de eventual desconexão. */
export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const snapshot = await currentQr(orgId);

    return jsonOk({
      qrCode: snapshot.qrCode,
      createdAt: snapshot.createdAt ?? null,
      ageMs: snapshot.ageMs ?? null,
      status: snapshot.state,
      state: snapshot.state,
      detail: snapshot.detail ?? null,
      lastStatusCode: snapshot.lastStatusCode ?? null,
      reconnectAttempts: snapshot.reconnectAttempts ?? null,
      justPaired: snapshot.justPaired ?? false,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.object({
  /** "new" derruba a sessão salva e força um QR Code novinho. */
  action: z.enum(["new"]),
});

/** POST /api/whatsapp/qr { action: "new" } — gera novo QR (limpa credenciais mortas). */
export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    postSchema.parse(await req.json());

    // connect({freshQr:true}) só devolve depois que há QR na tela, conexão aberta ou erro
    // explicado — por isso o snapshot lido em seguida é o novo, não o velho.
    await connect(orgId, { freshQr: true });
    const snapshot = await currentQr(orgId);

    return jsonOk({
      qrCode: snapshot.qrCode,
      createdAt: snapshot.createdAt ?? null,
      ageMs: snapshot.ageMs ?? null,
      status: snapshot.state,
      state: snapshot.state,
      detail: snapshot.detail ?? null,
      lastStatusCode: snapshot.lastStatusCode ?? null,
      reconnectAttempts: snapshot.reconnectAttempts ?? null,
      justPaired: snapshot.justPaired ?? false,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
