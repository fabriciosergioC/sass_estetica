/**
 * Nomes estáveis de provider (§29). Ficam num arquivo porque três lugares precisam bater
 * com o banco: `WhatsAppConnection.provider`, a UI de Configurações e o registro de adapters.
 */

export const BARIELS_NAME = "BARIELS";
export const MOCK_NAME = "MOCK";

/**
 * Alias aceitos em `WHATSAPP_PROVIDER` e no cadastro da conexão → nome canônico.
 * `baileys` continua valendo porque é o que já está gravado nas conexões existentes e no
 * `.env` de quem atualizou o projeto; `dev` NÃO vale mais como envio silencioso (era o que
 * fingia "enviado" sem mandar nada) — ele só existe como sinônimo do modo mock.
 */
export const PROVIDER_ALIASES: Record<string, string> = {
  bariels: BARIELS_NAME,
  bariel: BARIELS_NAME,
  baileys: BARIELS_NAME,
  mock: MOCK_NAME,
  dev: MOCK_NAME,
};

/** Providers ainda não implementados: aparecem na UI, falham de forma explicativa. */
export const FUTURE_PROVIDERS = ["EVOLUTION", "META_CLOUD", "ZAPI"] as const;

export function canonicalProvider(name?: string | null): string | null {
  if (!name) return null;
  return PROVIDER_ALIASES[name.toLowerCase()] ?? null;
}
