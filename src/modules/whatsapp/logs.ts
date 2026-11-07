import { db } from "@/lib/db";
import type { WhatsAppAdapterError } from "./adapter";

/**
 * Trilha de eventos do módulo WhatsApp (§24). Alimenta a tela "WhatsApp → Logs".
 *
 * Regra da casa, escrita aqui em vez de confiar na disciplina de quem chama: NUNCA
 * gravamos credencial, token, chave de API, QR cru ou conteúdo de mensagem no log. Por
 * isso todo texto passa por `redact()`, que corta o que se parece com segredo e o que se
 * parece com imagem base64 antes de encostar no banco.
 */

export type WaLogLevel = "info" | "warn" | "error";

export type WaLogInput = {
  orgId?: string | null;
  level?: WaLogLevel;
  /** Nome estável do evento: connection.qr, message.sent, adapter.error ... */
  event: string;
  /** Quem participou: número, jid ou e-mail do usuário. */
  actor?: string | null;
  endpoint?: string | null;
  status?: string | null;
  detail?: string | null;
};

const SECRET_KEY_RE =
  /(api[_-]?key|apikey|token|authorization|bearer|secret|password|passwd|credential|session[_-]?id|access[_-]?key)/i;
const BASE64_BLOB_RE = /[A-Za-z0-9+/]{200,}={0,2}/g;

/**
 * Limita tamanho e esconde segredos.
 * `k=v` cuja chave parece segredo vira `k=[redigido]`; sequências longas de base64 (QR,
 * foto, áudio) viram `[base64 omitido]`.
 */
export function redact(input: string | null | undefined, max = 500): string | null {
  if (!input) return null;
  let out = String(input);

  out = out.replace(/([?&]?\b[\w-]*(?:key|token|secret|password|credential)[\w-]*)\s*[=:]\s*\S+/gi, "$1=[redigido]");
  out = out.replace(SECRET_KEY_RE, (m) => `${m.slice(0, 4)}…`);
  out = out.replace(BASE64_BLOB_RE, "[base64 omitido]");
  out = out.replace(/\s+/g, " ").trim();

  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Escreve na trilha. Nunca lança: log não pode derrubar o fluxo de mensagens. */
export async function logWa(input: WaLogInput): Promise<void> {
  try {
    await db.whatsAppLog.create({
      data: {
        orgId: input.orgId ?? null,
        level: input.level ?? "info",
        event: input.event.slice(0, 80),
        actor: redact(input.actor, 80),
        endpoint: redact(input.endpoint, 120),
        status: redact(input.status, 40),
        detail: redact(input.detail),
      },
    });
  } catch (err) {
    console.error(`[WhatsApp:log] falha ao gravar "${input.event}":`, err);
  }
}

/** Loga e devolve — para não trocar `await logWa(...)` por `return logWa(...)` no chamador. */
export async function logWaReturn<T>(input: WaLogInput, value: T): Promise<T> {
  await logWa(input);
  return value;
}

/** Texto amigo de um erro (§17): usa a mensagem do adapter quando houver, senão o código. */
export function friendlyError(err: unknown, fallback = "Não foi possível concluir no WhatsApp."): string {
  if (err instanceof Error) {
    const e = err as Error & { friendly?: string };
    return redact(e.friendly ?? e.message, 300) ?? fallback;
  }
  return redact(String(err), 300) ?? fallback;
}

export type { WhatsAppAdapterError };
