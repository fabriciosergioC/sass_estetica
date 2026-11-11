/**
 * Formas de pagamento do caixa.
 *
 * O banco guarda o código (`CASH`, `PIX`, `CARD`, `OTHER`); o rótulo que o operador lê vem
 * daqui. Tela e API usam esta mesma lista para não existir "Cartão" em uma e "CARD" na outra.
 */
export const PAYMENT_METHODS = [
  { id: "CASH", label: "Dinheiro", icon: "💵" },
  { id: "PIX", label: "PIX", icon: "⚡" },
  { id: "CARD", label: "Cartão", icon: "💳" },
  { id: "OTHER", label: "Outro", icon: "🧾" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["id"];

/** Tuple para o `z.enum` — o zod exige pelo menos um valor conhecido em tempo de tipo. */
export const PAYMENT_METHOD_IDS = PAYMENT_METHODS.map((method) => method.id) as [
  PaymentMethod,
  ...PaymentMethod[],
];

export function paymentMethodLabel(method: string | null | undefined): string {
  return PAYMENT_METHODS.find((option) => option.id === method)?.label ?? "Outro";
}