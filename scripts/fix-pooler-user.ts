/**
 * Conserta o erro mais comum do `DATABASE_URL` do Supabase, sem você precisar digitar a senha de novo.
 *
 * O que acontece: no painel, o botão "Copy" da connection string tem um interruptor
 * **Use legacy connection string**. Com ele ligado (ou com a string "direta" colada no pooler), o
 * usuário vem como `postgres`. A conexão abre, o Prisma manda a primeira query e o Supavisor
 * responde:
 *
 *     FATAL: (ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname required)
 *
 * O pooler do Supabase atende dezenas de projetos no mesmo host, então ele precisa saber em qual
 * você está — e o identificador é o sufixo do usuário: `postgres.<ref>`. A conexão direta (host
 * `db.<ref>.supabase.co`) não precisa, porque o próprio host já diz o projeto.
 *
 * Este script só troca o usuário do `DATABASE_URL`. A senha é copiada byte a byte do valor que já
 * está lá — ela nunca é impressa nem passa por lugar nenhum.
 *
 * Uso:
 *   npx tsx scripts/fix-pooler-user.ts               # acrescenta .<ref> ao usuário do pooler
 *   npx tsx scripts/fix-pooler-user.ts --pooler <região>
 *       # reescreve o host do pooler para a região certa, mantendo usuário e senha. Foi o que
 *       # resolveu este projeto: a aba "URIs" do Connect mostra aws-0-sa-east-1, mas o tenant está
 *       # registrado em aws-0-us-east-1 (é o que a aba "ORM" imprime).
 *   npx tsx scripts/fix-pooler-user.ts --limite <n>
 *       # grava connection_limit=<n> no DATABASE_URL. Resolve o caso em que o app estoura o teto de
 *       # clientes do session pooler (plano gratuito: 15) e o Postgres responde
 *       # `EMAXCONNSESSION max clients reached in session mode`.
 *   npx tsx scripts/fix-pooler-user.ts --usar-direta # usa a conexão direta como runtime (provisório)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { lerChave, resumir, setLine, validar } from "./setup-supabase-env";

const ENV_PATH = ".env";

// `lerChave` mora no setup-supabase-env (é a ferramenta de .env); re-exportado aqui para quem
// consome este módulo continuar funcionando.
export { lerChave };

/** O ref do projeto a partir do host da conexão direta: db.<ref>.supabase.co → <ref>. */
export function refDaDireta(directUrl: string | null): string | null {
  if (!directUrl) return null;
  const sep = directUrl.lastIndexOf("@");
  if (sep < 0) return null;
  const host = directUrl.slice(sep + 1).split(/[/?#:]/)[0];
  return host.match(/^db\.([A-Za-z0-9-]+)\.supabase\.co$/)?.[1] ?? null;
}

/**
 * Acrescenta `.<ref>` ao usuário, mas só quando faz falta: host de pooler e usuário sem ponto.
 * Devolve `null` quando não há nada a corrigir. A substituição é na crua da string, para a senha
 * continuar exatamente como está (inclusive os %xx de escape).
 */
export function corrigirPooler(
  url: string | null,
  ref: string
): { novo: string; usuario: string; host: string } | null {
  if (!url || !ref) return null;
  const sep = url.lastIndexOf("@");
  if (sep < 0) return null;
  const host = url.slice(sep + 1).split(/[/?#:]/)[0];
  if (!/pooler\.supabase\.com$/i.test(host)) return null;
  const ini = url.indexOf("://");
  if (ini < 0) return null;
  const corpo = url.slice(ini + 3, sep);
  const doisPontos = corpo.indexOf(":");
  const usuario = doisPontos < 0 ? corpo : corpo.slice(0, doisPontos);
  if (!usuario || usuario.includes(".")) return null;
  const novo = `${url.slice(0, ini + 3)}${usuario}.${ref}${url.slice(ini + 3 + usuario.length)}`;
  return { novo, usuario, host };
}

/**
 * Copia a senha que já está na string, percent-encoding o que não é permitido em userinfo
 * (`@`, `:`, `[`, `]`, `%` solto). Os `%XX` que já existem são preservados, para não virar `%25XX`.
 */
export function codificarSenha(bruta: string): string {
  return bruta.replace(/[^A-Za-z0-9\-._~%]|%(?![0-9A-Fa-f]{2})/g, (c) => encodeURIComponent(c));
}

/** Extrai a senha crua de uma connection string (entre o primeiro `:` depois do `//` e o último `@`). */
export function senhaDaUrl(url: string): string | null {
  const sep = url.lastIndexOf("@");
  const ini = url.indexOf("://");
  if (sep < 0 || ini < 0) return null;
  const corpo = url.slice(ini + 3, sep);
  const dp = corpo.indexOf(":");
  return dp < 0 ? null : corpo.slice(dp + 1);
}

/** Monta a URI do session pooler do Supabase na região dada, reusando a senha que já está no arquivo. */
export function montarPooler(
  urlOriginal: string,
  deOndePegarSenha: string,
  ref: string,
  regiao: string
): string {
  const senha = senhaDaUrl(deOndePegarSenha) ?? senhaDaUrl(urlOriginal);
  if (!senha) throw new Error("não achei senha em nenhuma das duas strings");
  const usuario = ref ? `postgres.${ref}` : "postgres";
  // params de query (?connection_limit=…) são da aplicação, não do host: sobrevivem à troca de região
  const params = urlOriginal.includes("?") ? `?${urlOriginal.slice(urlOriginal.indexOf("?") + 1)}` : "";
  return `postgresql://${usuario}:${codificarSenha(senha)}@aws-0-${regiao}.pooler.supabase.com:5432/postgres${params}`;
}

/**
 * Grava (ou troca) `connection_limit` na string, sem mexer em nenhum outro param. A substituição é
 * na crua, porque `URL` decodifica o userinfo e reescrever a senha com outra codificação é exatamente
 * o tipo de coisa que quebra um `@` ou `%25` no meio da senha.
 */
export function comLimita(url: string, limite: number): string {
  if (!Number.isInteger(limite) || limite < 1 || limite > 100) {
    throw new Error("limite inválido: use um inteiro de 1 a 100");
  }
  const i = url.indexOf("?");
  const base = i < 0 ? url : url.slice(0, i);
  const params = (i < 0 ? [] : url.slice(i + 1).split("&")).filter((p) => p && !/^connection_limit=/i.test(p));
  params.push(`connection_limit=${limite}`);
  return `${base}?${params.join("&")}`;
}

async function main() {
  let content: string;
  try {
    content = readFileSync(ENV_PATH, "utf8");
  } catch {
    console.error(`Não achei ${ENV_PATH} em ${process.cwd()}. Rode a partir da raiz do projeto.`);
    process.exit(1);
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";

  const databaseUrl = lerChave(content, "DATABASE_URL");
  const directUrl = lerChave(content, "DIRECT_URL");

  if (!databaseUrl) {
    console.error("DATABASE_URL não existe no .env. Rode primeiro: npx tsx scripts/setup-supabase-env.ts");
    process.exit(1);
  }

  /*
   * `--pooler <região>`: monta o DATABASE_URL no session pooler da região que o painel mostra,
   * reusando a senha que já está gravada. É o conserto quando o pooler responde
   * `tenant/user postgres.<ref> not found` porque o host foi escrito à mão com a região errada
   * (a região certa está no painel: botão Connect → aba ORM/Manual, no host aws-0-<região>...).
   */
  const args = process.argv.slice(2);
  const iPooler = args.findIndex((a) => /^--pooler$/i.test(a));
  if (iPooler >= 0) {
    const regiao = (args[iPooler + 1] ?? "").trim();
    if (!/^[a-z]+-[a-z]+-\d$/i.test(regiao)) {
      console.error(
        "falta a região do pooler. Uso: npx tsx scripts/fix-pooler-user.ts --pooler us-east-1\n" +
          "A região é a que aparece no host da connection string do painel (Connect -> ORM/Manual)."
      );
      process.exit(1);
    }
    const ref = refDaDireta(directUrl);
    if (!ref) {
      console.error("não deu para deduzir o ref pelo DIRECT_URL; rode npx tsx scripts/setup-supabase-env.ts");
      process.exit(1);
    }
    const novo = montarPooler(databaseUrl, directUrl ?? databaseUrl, ref, regiao);
    if (novo === databaseUrl) {
      console.log(`DATABASE_URL já está em aws-0-${regiao}.pooler.supabase.com:5432 com o usuário certo.`);
      process.exit(0);
    }
    console.log(`antes:  ${resumir(databaseUrl)}`);
    console.log(`agora:  ${resumir(novo)}`);
    writeFileSync(ENV_PATH, setLine(content, "DATABASE_URL", novo, eol), "utf8");
    console.log("\nGravado (só a linha DATABASE_URL). Confira com npm run db:check.");
    process.exit(0);
  }

  /*
   * `--limite <n>`: grava `?connection_limit=<n>` no DATABASE_URL (troca o valor se já existir).
   * Por que isso existe: o session pooler do Supabase tem teto de clientes por sessão — no plano
   * gratuito é 15. Sem o limite, o Prisma abre até `2 × núcleos + 1` conexões por processo, e uma
   * página que dispara 15 queries em paralelo (é o caso do /api/dashboard) estoura o teto e o
   * Supavisor responde `FATAL: (EMAXCONNSESSION) max clients reached in session mode`. Com limite
   * baixo o Prisma enfileira as queries dentro das próprias conexões — nada quebra, só espera.
   */
  const iLimite = args.findIndex((a) => /^--limite$/i.test(a));
  if (iLimite >= 0) {
    const n = (args[iLimite + 1] ?? "").trim();
    if (!/^\d{1,2}$/.test(n)) {
      console.error("falta o número de conexões. Uso: npx tsx scripts/fix-pooler-user.ts --limite 5");
      process.exit(1);
    }
    const novo = comLimita(databaseUrl, Number(n));
    if (novo === databaseUrl) {
      console.log(`DATABASE_URL já tem connection_limit=${n}.`);
      process.exit(0);
    }
    console.log(`antes:  ${resumir(databaseUrl)}`);
    console.log(`agora:  ${resumir(novo)}`);
    writeFileSync(ENV_PATH, setLine(content, "DATABASE_URL", novo, eol), "utf8");
    console.log(`\nGravado (só a linha DATABASE_URL). O app passa a usar no máximo ${n} conexões.`);
    console.log("Reinicie o npm run dev para pegar a URL nova e confira com npm run db:check.");
    process.exit(0);
  }

  /*
   * `--usar-direta`: copia o valor do DIRECT_URL para o DATABASE_URL, para o app falar com o
   * Supabase pela conexão direta enquanto o pooler não existe. É a saída quando o pooler responde
   * "tenant/user ... not found" — nesse caso não adianta consertar o usuário, o projeto não está
   * registrado naquele pooler (região errada no host, ou o pooling está desligado no painel).
   * Serve para desenvolver no PC; antes de publicar num provedor serverless, volte para o pooler.
   */
  if (process.argv.slice(2).includes("--usar-direta")) {
    if (!directUrl) {
      console.error("não tem DIRECT_URL no .env para copiar; rode npx tsx scripts/setup-supabase-env.ts");
      process.exit(1);
    }
    const hostRuntime = databaseUrl.slice(databaseUrl.lastIndexOf("@") + 1).split("/")[0];
    const hostDireto = directUrl.slice(directUrl.lastIndexOf("@") + 1).split("/")[0];
    if (hostRuntime === hostDireto) {
      console.log(`DATABASE_URL já aponta para ${hostDireto}. Nada a fazer.`);
      process.exit(0);
    }
    console.log(`antes:  ${resumir(databaseUrl)}`);
    console.log(`agora:  ${resumir(directUrl)}`);
    writeFileSync(ENV_PATH, setLine(content, "DATABASE_URL", directUrl, eol), "utf8");
    console.log("\nGravado. O CRM agora usa a conexão direta: uma conexão real de Postgres por conexão");
    console.log("do Prisma. Funciona bem no desenvolvimento local; para publicar em serverless, acione");
    console.log("o pooler no painel (Project Settings -> Database -> Connection pooling) e rode de");
    console.log("novo este script sem a flag. Confira com npm run db:check.");
    process.exit(0);
  }

  const ref = refDaDireta(directUrl);
  if (!ref) {
    const rl = createInterface({ input: stdin, output: stdout });
    console.log("Não deu para deduzir o ref do projeto pelo DIRECT_URL.");
    console.log("É o pedaço da URL do painel: https://supabase.com/dashboard/project/<REF>/\n");
    const digitado = (await rl.question("ref do projeto: ")).trim();
    rl.close();
    if (!/^[A-Za-z0-9-]+$/.test(digitado)) {
      console.error("ref inválido; nada foi alterado.");
      process.exit(1);
    }
    const a = corrigirPooler(databaseUrl, digitado);
    if (!a) {
      console.log("Nada a corrigir: o DATABASE_URL já não é do tipo que precisa do ref.");
      process.exit(0);
    }
    console.log(`\nantes:  ${resumir(databaseUrl)}`);
    console.log(`agora:  ${resumir(a.novo)}`);
    writeFileSync(ENV_PATH, setLine(content, "DATABASE_URL", a.novo, eol), "utf8");
    console.log("\nDATABASE_URL atualizado. Rode npm run db:check para confirmar.");
    return;
  }

  const a = corrigirPooler(databaseUrl, ref);
  if (!a) {
    console.log(`DATABASE_URL não precisa de correção (usuário já tem o ref, ou o host não é pooler).`);
    console.log(`hoje: ${resumir(databaseUrl)}`);
    process.exit(0);
  }

  console.log(`ref do projeto (deduzido do DIRECT_URL): ${ref}`);
  console.log(`antes:  ${resumir(databaseUrl)}`);
  console.log(`agora:  ${resumir(a.novo)}`);
  const avisos = validar(a.novo, "DATABASE_URL");
  for (const w of avisos) console.log(`\n[atenção] ${w}`);

  writeFileSync(ENV_PATH, setLine(content, "DATABASE_URL", a.novo, eol), "utf8");
  console.log("\nGravado no .env (só a linha DATABASE_URL; o resto ficou intacto).");
  console.log("Confirme com: npm run db:check");
}

// Só roda quando o arquivo é invocado direto — assim as funções acima podem ser testadas sem
// tocar no .env real.
const executandoDireto = (process.argv[1] ?? "").split(/[\\/]/).pop() === "fix-pooler-user.ts";
if (executandoDireto) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
