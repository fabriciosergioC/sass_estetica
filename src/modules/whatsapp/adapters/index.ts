import { db } from "@/lib/db";
import { WhatsAppAdapterError, type WhatsAppAdapter } from "../adapter";
import { BarielsAdapter } from "./bariels";
import { MockAdapter } from "./mock";
import { BARIELS_NAME, FUTURE_PROVIDERS, MOCK_NAME, PROVIDER_ALIASES, canonicalProvider } from "./names";

/**
 * Registro de adapters (§29).
 *
 * A mudança decisiva em relação ao código antigo: não existe mais `default: new DevProvider()`.
 * Antes, um nome de provider desconhecido ou um `WHATSAPP_PROVIDER` vazio devolvia um provedor
 * que respondia "enviado" sem falar com o WhatsApp — foi assim que 32 mensagens apareceram
 * como entregues e nenhuma chegou. Aqui, nome desconhecido = erro explícito.
 */

let bariels: BarielsAdapter | null = null;
let mock: MockAdapter | null = null;

/** `WHATSAPP_MOCK=true` (ou `1`) liga o modo simulado para todo o processo (§32). */
export function isMockEnabled(): boolean {
  const v = (process.env.WHATSAPP_MOCK ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/** O provider declarado pela conexão da org, caindo para o `.env` e, só então, para Bariels. */
export async function providerNameForOrg(orgId: string): Promise<string> {
  if (isMockEnabled()) return MOCK_NAME;
  const conn = await db.whatsAppConnection.findUnique({ where: { orgId }, select: { provider: true } });
  const declared = conn?.provider ?? process.env.WHATSAPP_PROVIDER ?? "";
  // "DEV" é o default antigo do schema; nunca é um provider real.
  if (!declared || declared.toUpperCase() === "DEV") return BARIELS_NAME;
  return canonicalProvider(declared) ?? declared.toUpperCase();
}

export function getAdapter(name?: string | null): WhatsAppAdapter {
  const requested = isMockEnabled() ? MOCK_NAME : canonicalProvider(name ?? process.env.WHATSAPP_PROVIDER ?? "") ?? (name ?? "").toUpperCase();

  if (requested === MOCK_NAME) {
    mock ??= new MockAdapter();
    return mock;
  }
  if (requested === BARIELS_NAME) {
    bariels ??= new BarielsAdapter();
    return bariels;
  }
  if ((FUTURE_PROVIDERS as readonly string[]).includes(requested)) {
    throw new WhatsAppAdapterError(
      "AUTH_ERROR",
      `O provedor "${requested}" ainda não tem adapter neste projeto.`,
      `O provedor ${requested} ainda não está disponível. Escolha Bariels (WhatsApp Web) ou ative o modo mock.`
    );
  }

  throw new WhatsAppAdapterError(
    "UNKNOWN",
    `Provedor de WhatsApp desconhecido: "${name ?? process.env.WHATSAPP_PROVIDER ?? ""}".`,
    'Configure WHATSAPP_PROVIDER como "bariels" (WhatsApp Web) ou ative WHATSAPP_MOCK=true para testes.'
  );
}

/** Lista exibida em Configurações → WhatsApp → Provedor (§29). */
export function listProviders(): { name: string; label: string; implemented: boolean; mock: boolean }[] {
  return [
    { name: BARIELS_NAME, label: "Bariels (WhatsApp Web)", implemented: true, mock: false },
    { name: MOCK_NAME, label: "Modo de teste (simulado)", implemented: true, mock: true },
    ...FUTURE_PROVIDERS.map((name) => ({
      name,
      label: PROVIDER_ALIASES[name.toLowerCase()] ? name : name,
      implemented: false,
      mock: false,
    })),
  ];
}

export { BarielsAdapter, MockAdapter };
export { BARIELS_NAME, MOCK_NAME };
export { canonicalProvider, PROVIDER_ALIASES } from "./names";
