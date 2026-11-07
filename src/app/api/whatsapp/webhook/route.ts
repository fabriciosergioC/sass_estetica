import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { containsCI } from "@/lib/search";
import { getAdapter, providerNameForOrg } from "@/modules/whatsapp/adapters";
import { ingestEvent } from "@/modules/whatsapp/ingest";
import { logWa, redact } from "@/modules/whatsapp/logs";
import type { NormalizedEvent } from "@/modules/whatsapp/types";

/**
 * POST /api/whatsapp/webhook — entrada HTTP de provedores externos (§11/§15).
 *
 * Hoje o provedor ativo (Bariels/WhatsApp Web) entrega eventos pelo socket e não usa esta
 * rota — ela existe para o dia em que a barbearia escolher uma API HTTP, e para o modo
 * simulado mandar eventos de teste. Por isso ela não conhece fornecedor nenhum: quem traduz
 * o payload cru é `adapter.normalizeRaw`, e quem escreve no banco é o ingest único.
 *
 * Autenticação: segredo compartilhado, nunca sessão de browser.
 *   WHATSAPP_WEBHOOK_SECRET (ou BAPIELS_WEBHOOK_SECRET) no .env
 *   header "x-webhook-secret: <segredo>"  |  ?secret=<segredo>
 *
 * Body aceito: um evento, um array de eventos, ou `{events: [...]}`. O org é resolvido por
 * `orgId` no corpo/querystring, ou pelo `instance`/`phone` que o provedor informar.
 */
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET ?? process.env.BARIELS_WEBHOOK_SECRET ?? process.env.CRON_SECRET;
  if (!secret) return false; // sem segredo configurado a rota fica fechada de propósito
  const provided =
    req.headers.get("x-webhook-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url).searchParams.get("secret");
  return provided === secret;
}

/** Qual barbearia este payload pertence? Sem resposta inequívoca, descartamos. */
async function resolveOrgId(payload: Record<string, any>, url: URL): Promise<string | null> {
  const direct = payload.orgId ?? url.searchParams.get("orgId");
  if (direct) {
    const org = await db.organization.findFirst({ where: { id: String(direct) }, select: { id: true } });
    return org?.id ?? null;
  }

  const instance = payload.instance ?? payload.account ?? url.searchParams.get("instance");
  if (instance) {
    const conn = await db.whatsAppConnection.findFirst({
      where: { provider: containsCI(String(instance).slice(0, 20)) },
      select: { orgId: true },
    });
    if (conn) return conn.orgId;
  }

  const phone = String(payload.phone ?? payload.to ?? payload.remoteJid ?? "").replace(/\D/g, "");
  if (phone.length >= 10) {
    const contact = await db.whatsAppContact.findFirst({
      where: { phone: containsCI(phone.slice(-9)) },
      select: { orgId: true },
    });
    if (contact) return contact.orgId;
  }

  return null;
}

/** Chave estável do evento: o id que o provedor deu, ou um resumo determinístico do corpo. */
function fingerprint(item: unknown, event: NormalizedEvent): string | null {
  const node = (item ?? {}) as Record<string, any>;
  const explicit =
    node.message_id ?? node.messageId ?? node.id ?? node.eventId ?? node.evolution_reference?.key?.id;
  if (explicit) return `${event.type}:${String(explicit).slice(0, 120)}`;

  if (event.type === "message.upsert") {
    return `${event.type}:${event.message.jid}:${event.message.providerMsgId}`.slice(0, 180);
  }
  if (event.type === "message.status") {
    return `${event.type}:${event.providerMsgId}:${event.status}`.slice(0, 180);
  }
  // Sem id nenhum não há como deduplicar — melhor processar de novo do que perder o evento.
  return null;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return jsonOk({ error: "Não autorizado." }, 401);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonOk({ error: "Payload precisa ser JSON." }, 400);
  }

  const node = raw as Record<string, any>;
  const payloads: unknown[] = Array.isArray(node)
    ? node
    : Array.isArray(node?.events)
      ? node.events
      : [raw];

  const orgId = await resolveOrgId(node ?? {}, new URL(req.url));
  if (!orgId) {
    await logWa({ level: "warn", event: "webhook.unmatched", detail: redact(JSON.stringify(node ?? {}).slice(0, 300)) });
    return jsonOk({ error: "Não foi possível identificar a clínica deste evento (informe orgId ou instance)." }, 400);
  }

  const adapter = getAdapter(await providerNameForOrg(orgId));
  const accepted: string[] = [];
  const rejected: string[] = [];
  let duplicates = 0;

  for (const item of payloads) {
    let event: NormalizedEvent | null = null;
    try {
      event = adapter.normalizeRaw(item);
    } catch (err) {
      rejected.push(redact(err instanceof Error ? err.message : String(err)) ?? "normalize falhou");
      continue;
    }
    if (!event) {
      rejected.push("formato não reconhecido");
      continue;
    }

    // Idempotência (§33): API de WhatsApp reenvia o mesmo evento quando não recebe 2xx a
    // tempo. `WebhookEvent` tem unique(provider, externalId) — a segunda entrega esbarra na
    // chave e é contada como duplicada, não gravada de novo.
    const externalId = fingerprint(item, event);
    if (externalId) {
      try {
        await db.webhookEvent.create({
          data: {
            orgId,
            provider: adapter.name,
            externalId,
            // Guardamos um resumo redigido, não o corpo: payload cru tem dado pessoal.
            payload: redact(JSON.stringify(item).slice(0, 500)) ?? "{}",
            processedAt: new Date(),
          },
        });
      } catch {
        duplicates += 1;
        continue;
      }
    }

    try {
      await ingestEvent({ ...event, orgId } as NormalizedEvent);
      accepted.push(event.type);
    } catch (err) {
      rejected.push(redact(err instanceof Error ? err.message : String(err)) ?? "ingest falhou");
    }
  }

  await logWa({
    orgId,
    level: rejected.length ? "warn" : "info",
    event: "webhook.received",
    actor: adapter.name,
    status: `${accepted.length}/${payloads.length}`,
    detail: rejected.length ? rejected.join(" | ") : null,
  });

  return jsonOk({
    ok: accepted.length > 0 || duplicates > 0,
    accepted: accepted.length,
    rejected: rejected.length,
    duplicates,
    rejectedReasons: rejected,
  });
}

/** Verificação de challenge no estilo Cloud API (só responde se o token estiver no .env). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!token) return jsonOk({ ok: true, mode: "socket", note: "Este provedor usa socket; webhook de verificação não é necessário." });
  if (url.searchParams.get("hub.verify_token") !== token) return jsonOk({ error: "Token de verificação inválido." }, 403);
  return new Response(url.searchParams.get("hub.challenge") ?? "ok", { status: 200 });
}
