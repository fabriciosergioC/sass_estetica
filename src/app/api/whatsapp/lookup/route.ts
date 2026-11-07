// Endpoint de diagnóstico SOMENTE DE LEITURA — não envia nada.
// Consulta o servidor do WhatsApp (USync) número por número e devolve exatamente o que ele
// respondeu, mais o que existe na store local (conversas/contatos) para cada forma do número.
// Protegido por CRON_SECRET (header x-cron-secret) para funcionar sem sessão no browser.
//
// Uso:
//   curl -H "x-cron-secret: <CRON_SECRET>" \
//        "http://localhost:3000/api/whatsapp/lookup?numbers=5531987707962&raw=1"
//
// `raw=1` consulta só os dígitos informados; sem ele também consultamos a forma brasileira
// equivalente (com/sem o 9º dígito), porque o servidor devolve uma ou outra.
//
// Obs.: este caminho NÃO pode ficar dentro de `_debug/` — pasta com "_" na frente é excluída
// do roteamento do App Router (foi por isso que /api/whatsapp/_debug/jobs sempre deu 404).
import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api";
import { getSock, resolveJid } from "@/modules/whatsapp/baileys/provider";
import { toWhatsAppDigits } from "@/lib/phone";

export const dynamic = "force-dynamic";

function localDigits(jid: unknown): string {
  return String(jid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

/** Celular BR: 55 + DDD + 8 dígitos (antes de 2016) ≡ 55 + DDD + 9 dígitos. */
function brVariants(digits: string): string[] {
  const out = new Set<string>([digits]);
  if (digits.startsWith("55") && digits.length === 13) {
    const rest = digits.slice(4);
    if (rest.length === 9 && ["6", "7", "8", "9"].includes(rest[0])) {
      out.add(`55${digits.slice(2, 4)}${rest.slice(1)}`);
    }
  } else if (digits.startsWith("55") && digits.length === 12 && digits.slice(4)[0] !== "9") {
    out.add(`55${digits.slice(2, 4)}9${digits.slice(4)}`);
  }
  return [...out];
}

type Resposta = {
  jid: string | null;
  existe: boolean;
  lid: string | null;
  do_numero_consultado: boolean;
};

type Answer = { consultado: string; respostas: Resposta[] };

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret");
  if (!secret || provided !== secret) return jsonOk({ error: "Não autorizado." }, 401);

  const url = new URL(req.url);
  const raw = url.searchParams.get("raw") === "1";
  const asked = (url.searchParams.get("numbers") ?? url.searchParams.get("phone") ?? "")
    .split(",")
    .map((s) => toWhatsAppDigits(s))
    .filter((d): d is string => Boolean(d));

  const sock = getSock() as any;
  if (!sock) return jsonOk({ error: "Socket do Baileys não está conectado neste processo." }, 503);

  const me = sock.authState?.creds?.me;
  const perNumber: {
    digits: string;
    queries: string[];
    answers: Answer[];
    error: string | null;
    store: Record<string, unknown>;
    resolucao: Record<string, unknown> | null;
  }[] = [];

  for (const digits of asked) {
    const queries = raw ? [digits] : brVariants(digits);
    const answers: Answer[] = [];
    let error: string | null = null;

    // Um USync por forma de número. Quando a conta não existe o <user> volta type="none" e o
    // Baileys descarta a entrada — consultando um de cada vez a ausência fica inequívoca
    // (em lote não dá para saber qual dos números ficou de fora).
    for (const q of queries) {
      try {
        const r: any[] = (await sock.onWhatsApp(q)) ?? [];
        answers.push({
          consultado: q,
          respostas: r.map((a) => ({
            jid: a?.jid ?? null,
            existe: Boolean(a?.exists),
            lid: a?.lid ?? null,
            do_numero_consultado: localDigits(a?.jid) === q || localDigits(a?.lid) === q,
          })),
        });
      } catch (err: any) {
        error = err?.message ?? String(err);
      }
    }

    const jids = new Set<string>([`${digits}@s.whatsapp.net`]);
    for (const a of answers) {
      for (const r of a.respostas) {
        if (r.jid) jids.add(r.jid);
        if (r.lid) jids.add(r.lid);
      }
    }
    const store: Record<string, unknown> = {};
    for (const jid of jids) {
      const chat = sock.store?.chats?.get?.(jid);
      store[`chat:${jid}`] = chat ? { lastMsgAt: chat.lastMsgAt ?? null, unread: chat.unreadCount ?? null } : null;
      store[`contato:${jid}`] = sock.store?.contacts?.get?.(jid) ?? null;
    }

    // O que o caminho de ENVIO decidiria para este número (mesma função usada no send).
    let resolucao: Record<string, unknown> | null = null;
    try {
      const r = await resolveJid(sock as any, digits);
      resolucao = { jid: r.jid ?? null, targetKind: r.targetKind ?? null, exists: r.exists ?? null, error: r.error ?? null };
    } catch (err: any) {
      resolucao = { error: err?.message ?? String(err) };
    }

    perNumber.push({ digits, queries, answers, error, store, resolucao });
  }

  return jsonOk({
    connectedAs: me ? { id: me.id, lid: (me as any).lid, name: me.name } : null,
    whatsAppUseLid: process.env.WHATSAPP_USE_LID ?? "0",
    perNumber,
  });
}
