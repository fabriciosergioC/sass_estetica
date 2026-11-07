/**
 * Preenche DATABASE_URL e DIRECT_URL no .env sem que as credenciais passem por lugar nenhum
 * além do terminal dele.
 *
 * Por que este script existe: o `.env` é justamente o arquivo que a gente não abre no editor de
 * código nem cola em conversa. Em vez de pedir a connection string no chat — onde a senha do banco
 * ficaria registrada no histórico —, quem digita é o próprio usuário, na própria janela.
 *
 * Uso:  npx tsx scripts/setup-supabase-env.ts
 *
 * O script só toca nas duas linhas DATABASE_URL/DIRECT_URL. Todo o resto do arquivo (SESSION_SECRET,
 * WHATSAPP_*, etc.) é regravado byte a byte, com o mesmo fim de linha que já estava lá.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ENV_PATH = ".env";

/** Mostra host/porta/banco e esconde o `usuario:senha`. */
export function resumir(url: string): string {
  try {
    const u = new URL(url);
    // o `?connection_limit=…` é o que se muda aqui, então tem de aparecer; a senha nunca aparece
    return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}${u.search}`;
  } catch {
    return "<não parece uma URL de conexão>";
  }
}

export function validar(url: string, nome: string): string[] {
  const avisos: string[] = [];
  if (!url) return [`${nome} vazio — vou gravar vazio mesmo assim, e o Prisma vai reclamar.`];
  if (!/^postgres(ql)?:\/\//.test(url)) {
    avisos.push(`${nome} não começa com postgresql:// — confere se colou a string certa.`);
  }
  try {
    const u = new URL(url);
    if (!u.password) avisos.push(`${nome} não tem senha no meio da URL.`);
    // Pooler de transação (6543) sem pgbouncer=true derruba prepared statement do Prisma.
    if (u.port === "6543" && !/pgbouncer=true/.test(u.search)) {
      avisos.push(
        `${nome} aponta para o pooler de transação (porta 6543) sem ?pgbouncer=true&connection_limit=1.`
      );
    }
    // A conexão direta do Supabase é IPv6 por padrão: em rede só-IPv4 ela não alcança, e aí o
    // session pooler (5432) é o fallback oficial — ele mantém sessão e prepared statements, então
    // dá para migrar por ele. O que NÃO serve para DDL é o pooler de transação (6543).
    // O Supavisor (pooler) atende vários projetos no mesmo host: ele identifica o projeto pelo
    // sufixo do usuário. Com `postgres` sozinho a conexão abre e morre na hora com
    // `FATAL: (ENOIDENTIFIER) no tenant identifier provided`.
    if (/pooler\.supabase\.com$/.test(u.hostname) && !u.username.includes(".")) {
      avisos.push(
        `${nome} usa o pooler com o usuário "${u.username || "(vazio)"}". No pooler o usuário tem de ser ` +
          `postgres.<ref-do-projeto> (ex.: postgres.abc123def456). Rode npx tsx scripts/fix-pooler-user.ts ` +
          `para corrigir sem digitar a senha de novo.`
      );
    }
    if (nome === "DIRECT_URL" && /pooler\.supabase\.com/.test(u.hostname)) {
      avisos.push(
        u.port === "6543"
          ? `${nome} está no pooler de transação (6543); a migração precisa de conexão com sessão própria — db.<ref>.supabase.co ou session pooler na 5432.`
          : `${nome} está no session pooler em vez da conexão direta (db.<ref>.supabase.co). Funciona para migrar; use assim só se a direta não conectar na sua rede (ela é IPv6 por padrão).`
      );
    }
    if (nome === "DATABASE_URL" && /^db\./.test(u.hostname)) {
      avisos.push(`${nome} está na conexão direta; o recomendado para runtime é o session pooler (porta 5432).`);
    }
  } catch {
    avisos.push(`${nome} não parseia como URL.`);
  }
  return avisos;
}

/**
 * Lê o valor bruto de uma chave no conteúdo do `.env` (com ou sem aspas). Usado pelo assistente
 * para "Enter vazio = mantém o que já estava" e pelo fix-pooler-user.
 */
export function lerChave(content: string, key: string): string | null {
  const m = content.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*([^\\r\\n]*)$`, "m"));
  if (m === null) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** Troca (ou acrescenta, na seção do banco) o valor de uma chave, preservando o resto do arquivo. */
export function setLine(content: string, key: string, value: string, eol: string): string {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  // Sem a chave no arquivo: coloca logo após DATABASE_URL, ou no topo.
  const after = /^[ \t]*DATABASE_URL[ \t]*=.*$/m;
  if (key !== "DATABASE_URL" && after.test(content)) {
    return content.replace(after, (m) => `${m}${eol}${line}`);
  }
  return `${line}${eol}${content.replace(/^[ \t]*\r?\n/, "")}`;
}

async function main() {
  // `--só-database-url` (ou --so-database-url) troca apenas o DATABASE_URL e deixa o DIRECT_URL
  // como está — é o jeito de corrigir uma string sem ter que recolar a outra.
  const soDatabaseUrl = process.argv.slice(2).some((a) => /^--(so|só)-database-url$/i.test(a));

  let content: string;
  try {
    content = readFileSync(ENV_PATH, "utf8");
  } catch {
    console.error(`Não achei ${ENV_PATH} em ${process.cwd()}. Rode a partir da raiz do projeto.`);
    process.exit(1);
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";

  const rl = createInterface({ input: stdin, output: stdout });
  console.log("Cole as connection strings do Supabase (botão Connect do painel, ou");
  console.log("Project Settings -> Database -> Connection string).");
  console.log("Elas não são impressas na tela e não vão para lugar nenhum além do .env.");
  console.log("Enter sozinho, numa das duas, mantém o valor que já está gravado.\n");

  const antigoDatabase = lerChave(content, "DATABASE_URL") ?? "";
  const DATABASE_URL =
    (await rl.question("DATABASE_URL (session pooler, porta 5432): ")).trim().replace(/^"|"$/g, "") ||
    antigoDatabase;

  let DIRECT_URL = lerChave(content, "DIRECT_URL") ?? "";
  if (!soDatabaseUrl) {
    const antigoDireta = DIRECT_URL;
    DIRECT_URL =
      (await rl.question("DIRECT_URL   (conexão direta, db.<ref>.supabase.co): ")).trim().replace(/^"|"$/g, "") ||
      antigoDireta;
  } else {
    console.log(`\nmodo --só-database-url: DIRECT_URL permanece ${resumir(DIRECT_URL)}`);
  }

  const avisos = [...validar(DATABASE_URL, "DATABASE_URL")];
  if (!soDatabaseUrl) avisos.push(...validar(DIRECT_URL, "DIRECT_URL"));
  for (const a of avisos) console.log(`\n[atenção] ${a}`);

  console.log(`\nDATABASE_URL -> ${resumir(DATABASE_URL)}`);
  console.log(`DIRECT_URL   -> ${resumir(DIRECT_URL)}`);

  if (avisos.length) {
    const ok = await rl.question("\nTem aviso acima. Gravar mesmo assim? (y/N): ");
    if (ok.trim().toLowerCase() !== "y") {
      rl.close();
      console.log("Cancelado; o .env não foi tocado.");
      process.exit(0);
    }
  }
  rl.close();

  let novo = setLine(content, "DATABASE_URL", DATABASE_URL, eol);
  if (!soDatabaseUrl) novo = setLine(novo, "DIRECT_URL", DIRECT_URL, eol);
  writeFileSync(ENV_PATH, novo, "utf8");

  console.log("\n.env atualizado. Confira assim:");
  console.log("  npm run db:check     (conexão do app, migrations e contagem — somente leitura)");
  console.log("Se você mexeu no schema antes disso: fechar o npm run dev, npm run db:generate,");
  console.log("npm run db:deploy.");
}

// Só roda quando executado direto — assim o `setLine`/`validar` podem ser testados sem abrir
// prompt nem escrever em arquivo nenhum.
const executandoDireto = (process.argv[1] ?? "").split(/[\\/]/).pop() === "setup-supabase-env.ts";

if (executandoDireto) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
