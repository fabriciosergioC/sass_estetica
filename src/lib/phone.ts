export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * Chave de comparação de telefone: só dígitos, reduzida à forma nacional brasileira.
 *
 * Por que existe: cada caminho de escrita gravava de um jeito — o cadastro manual do CRM grava
 * `+31987707962`, o agendamento online grava o texto formatado (`+55 (31) 98770-7962`), o seed
 * grava `+5511910000000`. Como o índice único da tabela é a STRING (`@@unique([orgId, phone])`),
 * a MESMA pessoa podia ser cadastrada três vezes sem o banco reclamar. Comparando por dígitos,
 * `+55 31 98770-7962`, `31987707962` e `(31) 98770-7962` viram a mesma chave `31987707962`.
 *
 * Regras:
 *  - descarta tudo que não for dígito (espaço, ponto, traço, parêntese, `+`) e o zero à esquerda;
 *  - remove o DDI `55` quando o número veio internacional (mais de 11 dígitos);
 *  - 10 ou 11 dígitos = DDD + número, que é a forma canônica usada aqui.
 *
 * Limite conhecido (o mesmo de `toWhatsAppDigits`): `+31 987707962` — Holanda de verdade — é
 * lido como DDD 31 brasileiro. Para estrangeiro real, grave com o DDI completo (mais de 11
 * dígitos depois de remover pontuação), que a chave acima não truncateia.
 */
export function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return "";
  if (digits.length > 11 && digits.startsWith("55")) return digits.slice(2);
  return digits;
}

/**
 * Dígitos no formato internacional que o WhatsApp exige (com DDI).
 *
 * Por que isso existe: os telefones são gravados como o cliente digitou
 * (`+31987707962`, `31 98770-7962`). Enviar `31987707962@s.whatsapp.net` faz o
 * WhatsApp ler "31" como código do país (Holanda) — o texto é aceito pelo
 * servidor e nunca chega no Brasil.
 *
 * Regras (na ordem):
 *  - `WHATSAPP_DEFAULT_DDI` vazio  → não completa nada, só devolve os dígitos.
 *  - já começa com o DDI padrão e tem tamanho de número nacional (10-11 dígitos
 *    depois do DDI) → usa como está.
 *  - tem exatamente 10 ou 11 dígitos (DDD + número brasileiro, sem DDI) → completa
 *    com o DDI padrão.
 *  - LID/group jid (16-18 dígitos, `120363422350287104`) ou curto demais → null:
 *    não é telefone, e mandar nele é o que produz "SENT que nunca entrega".
 *
 * Por que o "+" da esquerda é ignorado: `normalizePhone` sempre gravou
 * `+${dígitos}`, inclusive para números digitados sem código do país
 * (`(31) 98770-7962` virou `+31987707962`). Então "+" aqui não significa
 * "internacional". Consequência conhecida: um número que realmente seja da
 * Holanda (`+31` DDI) com 10-11 dígitos é lido como DDD 31 brasileiro. Para
 * esses casos grave o número já com o DDI completo (ex.: `+31 987707962` com
 * o DDI do país nos dígitos) ou deixe `WHATSAPP_DEFAULT_DDI=""`, o que
 * desliga a completação e devolve os dígitos como estão.
 */
export function toWhatsAppDigits(
  raw: string | null | undefined,
  defaultDdi: string = process.env.WHATSAPP_DEFAULT_DDI ?? "55"
): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;

  const ddi = defaultDdi.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;

  if (ddi && digits.startsWith(ddi) && digits.length >= ddi.length + 10) return digits;
  if (ddi && (digits.length === 10 || digits.length === 11)) return `${ddi}${digits}`;
  return digits;
}

/**
 * Todas as formas que o MESMO número brasileiro pode ter gravada no banco.
 *
 * Por que existe: `@@unique([orgId, jid])` e o índice de `phone` comparam string, e cada
 * época do projeto gravou de um jeito — o CRM com `+`, o agendamento com pontuação, o
 * adapter do WhatsApp com os dígitos internacionais já com DDI, e o WhatsApp alternando o
 * 9º dígito conforme a linha foi salva (`5531987707962` ↔ `553187707962`). Procurar por uma
 * forma só devolve "não existe" e o chamador cria a segunda ficha do mesmo cliente.
 *
 * Regras:
 *  - só vale para números de tamanho plausível de telefone (≤ 15 dígitos); um `@lid` tem
 *    16-20 dígitos e NÃO é telefone — devolver a própria string evita inventar variantes;
 *  - combina com/sem DDI e com/sem o 9º dígito, sempre mantendo o DDI no mesmo passo.
 */
export function whatsappPhoneVariants(
  raw: string | null | undefined,
  defaultDdi: string = process.env.WHATSAPP_DEFAULT_DDI ?? "55"
): string[] {
  const digits = (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length < 8 || digits.length > 15) return digits ? [digits] : [];

  const ddi = defaultDdi.replace(/\D/g, "");
  const national = ddi && digits.length > 11 && digits.startsWith(ddi) ? digits.slice(ddi.length) : digits;
  if (national.length < 10 || national.length > 11) return [...new Set([digits, national])];

  // 11 dígitos = DDD + 9 + número; 10 = DDD + número. As duas são a mesma pessoa.
  const withoutNine = national.length === 11 && national[2] === "9" ? `${national.slice(0, 2)}${national.slice(3)}` : null;
  const withNine = national.length === 10 ? `${national.slice(0, 2)}9${national.slice(2)}` : null;

  const out = new Set<string>([digits, national]);
  for (const n of [national, withoutNine, withNine]) {
    if (!n) continue;
    out.add(n);
    if (ddi) out.add(`${ddi}${n}`);
  }
  return [...out].filter(Boolean);
}
