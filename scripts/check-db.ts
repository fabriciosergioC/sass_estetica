/**
 * Confere se o CRM está de fato falando com o banco que está no `.env`.
 *
 * Uso: npm run db:check
 *
 * Por que existe: depois de mexer no `.env` você precisa de uma resposta curta — "conecta ou não
 * conecta, e o schema está aplicado?" — sem ter que abrir o Prisma Studio nem rodar nada que
 * escreva. Esta checagem é 100% leitura: versão do servidor, latência, migrations aplicadas e
 * contagem de linhas por tabela.
 *
 * Ela também é útil na virada de volta para SQLite, porque detecta o provedor pela URL.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/**
 * Mostra a conexão sem mostrar a senha. A regra do projeto é segredo não aparecer em tela de
 * terminal capturada, log nem conversa — então aqui só usuário, host, porta e banco.
 */
function mascarar(nome: string, valor: string | undefined): string {
  if (!valor) return `${nome}: <ausente no ambiente>`;
  if (valor.startsWith("file:")) return `${nome}: ${valor} (SQLite local)`;
  try {
    const u = new URL(valor);
    return `${nome}: ${u.username || "?"}:***@${u.host}${u.pathname}${u.search}`;
  } catch {
    return `${nome}: <não parseia como URL>`;
  }
}

async function main() {
  const runtimeUrl = process.env.DATABASE_URL;
  const directUrl = process.env.DIRECT_URL;
  const ehPostgres = !(runtimeUrl ?? "").startsWith("file:");

  console.log(mascarar("DATABASE_URL", runtimeUrl));
  if (directUrl) console.log(mascarar("DIRECT_URL  ", directUrl));
  try {
    if (directUrl && runtimeUrl && new URL(runtimeUrl).host === new URL(directUrl).host) {
      console.log(
        "        (as duas no mesmo host = você está na conexão direta, o plano B do SUPABASE.md.\n" +
          "         Para desenvolvimento local está certo; antes de publicar em serverless, acione o\n" +
          "         pooler no painel e rode npx tsx scripts/fix-pooler-user.ts)"
      );
    }
  } catch {
    /* uma das duas não parseia — o restante da checagem já vai dizer isso */
  }

  // 1) O servidor responde? E em quanto tempo?
  const latencias: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await db.$queryRaw`SELECT 1`;
    latencias.push(performance.now() - t0);
  }
  const versao = ehPostgres
    ? await db.$queryRaw<{ v: string }[]>`SELECT version() AS v`
    : await db.$queryRaw<{ v: string }[]>`SELECT sqlite_version() AS v`;
  console.log(`\nconexão: OK`);
  console.log(`servidor: ${String(versao[0]?.v).split("\n")[0]}`);
  console.log(
    `latência (SELECT 1): ${latencias.map((l) => `${l.toFixed(0)}ms`).join(" / ")} ` +
      (ehPostgres ? "(cada query do CRM paga esse ida-e-volta)" : "(banco local)")
  );

  // 2) Quais migrations estão aplicadas — só existe no Postgres.
  if (ehPostgres) {
    const tabs = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    console.log(`tabelas no schema public: ${tabs[0]?.n}`);
    try {
      const migrs = await db.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
        SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name`;
      console.log(`migrations aplicadas: ${migrs.length}`);
      for (const m of migrs) {
        console.log(`  - ${m.migration_name} (${m.finished_at ? new Date(m.finished_at).toLocaleString("pt-BR") : "pendente"})`);
      }
    } catch {
      console.log(`migrations aplicadas: a tabela _prisma_migrations não existe — rode npm run db:deploy`);
    }
  }

  // 3) O Prisma Client gerado bate com o schema? (é isso que o app usa nas rotas)
  const contagens: Record<string, number | string> = {};
  try {
    contagens.Organization = await db.organization.count();
    contagens.User = await db.user.count();
    contagens.Customer = await db.customer.count();
    contagens.Appointment = await db.appointment.count();
    contagens.Payment = await db.payment.count();
    contagens.WhatsAppConversation = await db.whatsAppConversation.count();
    contagens.WhatsAppMessage = await db.whatsAppMessage.count();
    contagens.WhatsAppConnection = await db.whatsAppConnection.count();
    console.log(`\nlinhas por tabela:`);
    for (const [t, n] of Object.entries(contagens)) console.log(`  ${t.padEnd(22)} ${n}`);
  } catch (err) {
    console.log(`\n[erro] a contagem falhou — o client gerado não confere com o banco:`);
    console.log(String((err as Error).message).split("\n").slice(0, 6).join("\n"));
    console.log(`se você mudou o schema, rode npm run db:generate (com o npm run dev fechado).`);
    process.exitCode = 1;
  }

  if (ehPostgres && contagens.Organization === 0) {
    console.log(`\nbanco conectado e vazio: certo para começar. Cadastre a empresa em /register e`);
    console.log(`marque sua conta com: npx tsx --env-file=.env scripts/set-superadmin.ts <seu e-mail>`);
  }
  console.log(`\nNada foi escrito no banco — esta checagem é somente leitura.`);
}

main()
  .catch((err) => {
    const msg = String((err as Error)?.message ?? err);
    console.error(`\n[falhou] ${msg}`);
    if (/tenant identifier|ENOIDENTIFIER/i.test(msg)) {
      console.error(
        "\nIsto é o pooler pedindo o identificador do projeto: no DATABASE_URL o usuário tem de ser\n" +
          "postgres.<ref> em vez de só postgres. Correção sem digitar senha:\n" +
          "  npx tsx scripts/fix-pooler-user.ts"
      );
    } else if (/tenant\/user .* not found|ENOTFOUND/i.test(msg)) {
      console.error(
        "\nO pooler não conhece esse projeto. Na prática é a REGIÃO no host: cada projeto existe em um\n" +
          "único aws-0-<região>.pooler.supabase.com, e a aba \"URIs\" do Connect mostra uma região enquanto\n" +
          "a aba \"ORM\" mostra outra — quem autentica é a do ORM. (Menos comum: pooling desligado em\n" +
          "Project Settings -> Database -> Connection pooling.)\n" +
          "Correção sem re-digitar a senha — troca só o host, mantendo a senha que já está no .env:\n" +
          "  npx tsx scripts/fix-pooler-user.ts --pooler <região>\n" +
          "Enquanto isso, dá para rodar na conexão direta (db.<ref>.supabase.co), que é por ela que o\n" +
          "`prisma migrate` já fala com o banco:\n" +
          "  npx tsx scripts/fix-pooler-user.ts --usar-direta"
      );
    } else if (/P1001|ECONNREFUSED|ETIMEDOUT|timeout/i.test(msg)) {
      console.error(
        "\nO host não respondeu. Se for a conexão direta (db.<ref>.supabase.co), ela é IPv6 por padrão e\n" +
          "não alcança em rede só-IPv4 — nesse caso aponte o DIRECT_URL para o session pooler (porta 5432)."
      );
    } else if (/password authentication|P1000|Invalid credentials/i.test(msg)) {
      console.error(
        "\nUsuário/senha recusados. Se você trocou a senha do banco no painel (Reset database password),\n" +
          "as duas strings do .env mudam juntas — cole as duas de novo."
      );
    }
    console.error(`(npm run db:status diz qual das duas variáveis está faltando)`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
