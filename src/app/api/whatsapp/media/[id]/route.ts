import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

/**
 * /api/whatsapp/media/[id] — anexos de uma mensagem (§15).
 *
 * Devolvemos o que temos guardado: quando a mídia é um data URL (anexo enviado pela tela ou
 * salvo por uma integração futura), `?binary=1` entrega o bytes com o content-type certo.
 * Quando o anexo chegou do WhatsApp e ainda não baixamos, a resposta diz isso com clareza —
 * preferimos isso a devolver um link do CDN que não abre sem a chave de sessão.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    const { id } = await params;

    const media = await db.whatsAppMedia.findFirst({
      where: { id, orgId },
      include: { message: { select: { id: true, direction: true, status: true, conversationId: true, orgId: true } } },
    });
    if (!media) return jsonOk({ error: "Mídia não encontrada." }, 404);

    const url = new URL(req.url);
    const asBinary = url.searchParams.get("binary") === "1";

    if (asBinary && media.url?.startsWith("data:")) {
      const [header, payload] = media.url.split(",");
      const mime = /data:([^;]+)/.exec(header)?.[1] ?? media.mimeType ?? "application/octet-stream";
      const buffer = Buffer.from(payload ?? "", "base64");
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(buffer.byteLength),
          "Cache-Control": "private, max-age=3600",
          "Content-Disposition": `inline; filename="${encodeURIComponent(media.fileName ?? `${media.kind}-${media.id}`)}"`,
        },
      });
    }

    if (asBinary) return jsonOk({ error: "Esta mídia não está armazenada localmente." }, 409);

    return jsonOk({
      media: {
        id: media.id,
        kind: media.kind,
        mimeType: media.mimeType,
        fileName: media.fileName,
        sizeBytes: media.sizeBytes,
        width: media.width,
        height: media.height,
        durationSec: media.durationSec,
        createdAt: media.createdAt,
        /** Presente quando guardamos o anexo (data URL); null quando só temos a referência. */
        available: Boolean(media.url),
        url: media.url ? `/api/whatsapp/media/${media.id}?binary=1` : null,
      },
      message: {
        id: media.message.id,
        direction: media.message.direction,
        status: media.message.status,
        conversationId: media.message.conversationId,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
