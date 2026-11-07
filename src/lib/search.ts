/**
 * Busca de texto livre, igual nos dois bancos que este projeto já conheceu.
 *
 * Por que isto existe num arquivo separado: `contains` do Prisma vira `LIKE`, e o `LIKE` do SQLite
 * ignora caixa para ASCII enquanto o do Postgres NÃO ignora. Sem este helper, ao virar para o
 * Supabase a busca de "clientes" passaria a não achar "João" quando o atendente digita "joão" —
 * regression silenciosa, que só aparece no dia a dia de quem usa.
 *
 * O `mode` só existe no client gerado para Postgres (no SQLite o engine responde "Unknown
 * argument `mode`", testado na prática), então ele não pode aparecer num objeto literal puro:
 * o typecheck quebraria enquanto o projeto ainda estiver no client SQLite. Daí o `as const` +
 * o retorno inferido — que é aceito pelos dois formatos de `StringFilter`.
 *
 * Quem procura telefone já normaliza dígitos antes, então a caixa não importa ali; ainda assim
 * usar o helper em tudo evita uma segunda regra de busca espalhada pelo código.
 */

/** `file:` = o SQLite local (`prisma/dev.db`). Qualquer outra coisa é Postgres/Supabase. */
const usesPostgres = !process.env.DATABASE_URL?.startsWith("file:");

export function containsCI(query: string) {
  return usesPostgres
    ? { contains: query, mode: "insensitive" as const }
    : { contains: query };
}
