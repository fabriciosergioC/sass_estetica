# Supabase (Postgres) — o que já está pronto e como ligar

O projeto foi preparado para gravar no Postgres do Supabase. O `prisma/schema.prisma` já é
`postgresql`, o baseline de migration Postgres já está gerado, e o código de busca já está pronto
para os dois dialetos. A virada já foi feita (veja o bloco acima); as seções abaixo documentam o
caminho para recriar em outro projeto, com os erros reais que cada passo produz.

> **Situação em 01/11/2026:** está aplicado e rodando no **session pooler**. `npm run db:check`
> responde `conexão: OK`, `PostgreSQL 17.11`, ~200 ms por query, as 41 tabelas do schema `public`, a
> migration `20261101000000_init_postgres` registrada, 1 empresa ("Bela Face"), 1 usuário
> (administrador da plataforma) e as demais tabelas vazias.
>
> As duas URLs que funcionam neste projeto (o segredo fica só no `.env`; `<senha>` abaixo é
> placeholder):
>
> - `DATABASE_URL` = `postgresql://postgres.gmyrwbqyojugymcmfbtg:<senha>@aws-0-us-east-1.pooler.supabase.com:5432/postgres?connection_limit=5`
> - `DIRECT_URL`   = `postgresql://postgres:<senha>@db.gmyrwbqyojugymcmfbtg.supabase.co:5432/postgres`
>
> O `connection_limit=5` não é enfeite: o session pooler do plano gratuito aceita 15 conexões e o
> Prisma abriria ~2× mais que isso por processo. Veja a linha `EMAXCONNSESSION` na tabela de erros.
>
> **Armadilha da região:** a aba *URIs* do painel mostra `aws-0-sa-east-1.pooler.supabase.com`, mas o
> tenant deste projeto está registrado em **`us-east-1`** — é o que a aba *ORM* imprime, e é o único
> host que autentica. Com `sa-east-1` o pooler responde `tenant/user ... not found`, que
> parece "pooling desligado" e não é. Para repetir a correção:
> `npx tsx scripts/fix-pooler-user.ts --pooler us-east-1` (reescreve só a linha `DATABASE_URL`,
> senha byte a byte como está, nunca impressa).
>
> `prisma/dev.db` continua intacto como arquivo de arquivo morto.

## O que mudou no código

| Arquivo | Mudança |
| --- | --- |
| `prisma/schema.prisma` | `provider = "postgresql"`, `url = env("DATABASE_URL")` e `directUrl = env("DIRECT_URL")` |
| `prisma/migrations/` | baseline novo `20261101000000_init_postgres/migration.sql` (40 tabelas, 52 índices, FKs) + `migration_lock.toml` = `postgresql` |
| `prisma/migrations_sqlite/` | as 4 migrations antigas, em dialeto SQLite, arquivadas com um `LEIA-ME.txt` |
| `src/lib/search.ts` | novo: `containsCI()` — busca de texto que funciona igual nos dois bancos |
| `inbox.ts`, `engagement.ts`, `webhook/route.ts`, `services/route.ts`, `customers/route.ts` | os 15 filtros `contains` passaram a usar o helper |
| `.env.example` | bloco do banco documentando as duas connection strings |
| `iniciar.ps1` | não roda mais `prisma db push --accept-data-loss` sozinho (veja o aviso abaixo) |
| `package.json` | scripts `db:generate`, `db:deploy`, `db:status`, `db:check` |

### Por que `containsCI`

No SQLite o `LIKE` ignora caixa em ASCII; no Postgres **não** ignora. Sem isso, depois da virada,
buscar "joão" no menu Clientes deixaria de achar "João" — regression silenciosa. O helper decide em
tempo de execução pela URL (`file:` = SQLite local, qualquer outra coisa = Postgres), então o
projeto funciona nos dois estados e não há janela quebrada entre o commit e a ativação.

### Por que o `iniciar.ps1` foi mexido

O bloco antigo testava `Test-Path dev.db`, mas o arquivo real é `prisma/dev.db` — o teste era
sempre falso, então `prisma db push --accept-data-loss` rodava **em todo start**. Com SQLite local
isso passava despercebido; com o Supabase seria um drop de coluna no banco da nuvem a cada duplo
clique no ícone. Hoje o iniciador só confere se as duas variáveis existem, e aplica migrations
apenas se você definir `DB_AUTOSYNC=1`.

## Ligar, em três comandos

1. **Cole as duas strings no `.env`.** No painel do Supabase, abra o projeto e clique no botão
   verde **Connect** (o mesmo menu aparece em Project Settings → Database → *Connection string*).
   Lá estão as duas strings deste projeto:

   ```
   DATABASE_URL="postgresql://postgres.<ref>:<senha>@aws-0-<região>.pooler.supabase.com:5432/postgres"
   DIRECT_URL="postgresql://postgres:<senha>@db.<ref>.supabase.co:5432/postgres"
   ```

   Repare no usuário: **com** `.<ref>` no pooler (é assim que ele escolhe o projeto entre os muitos
   que atendem naquele host) e **sem** `.<ref>` na conexão direta. A `<região>` é a que a aba **ORM**
   do menu Connect mostra — não necessariamente a que a aba *URIs* escreve; ver a armadilha acima.

   A `<senha>` é a **senha do banco** que você criou junto com o projeto — não é a sua senha de
   login do Supabase, e não é chave de API. Se não lembra dela: Project Settings → Database →
   **Reset database password** (depois do reset as duas strings mudam de senha, então copie de novo).

   **As chaves `anon` / `service_role` (Project Settings → API Keys) não servem aqui.** Elas são da
   Data API (REST/PostgREST), usada por app de celular que fala com o Supabase por HTTPS. Este
   projeto é um backend Node com Prisma: ele precisa da connection string do Postgres. E por
   segurança, `service_role` nunca vai para o front.

   Para digitar sem colar nada em lugar errado, use o assistente (ele valida, esconde a senha na
   tela e só toca nessas duas linhas do `.env`):

   ```
   npx tsx scripts/setup-supabase-env.ts
   ```

   **Se a conexão direta não conectar** (`ECONNREFUSED`/timeout em `db.<ref>.supabase.co`): essa
   rota é **IPv6 por padrão**, e em rede só-IPv4 ela não alcança — é o caso mais comum no Brasil.
   Aí use o **session pooler da porta 5432 também no `DIRECT_URL`** (o mesmo valor do
   `DATABASE_URL`, ou `postgres.<ref>` no caminho). O assistente avisa, mas pode gravar: migração
   por session pooler funciona. O que **não** funciona é o pooler de transação (porta 6543) para
   DDL — esse não mantém sessão nem prepared statements.

   `SESSION_SECRET` e `CRON_SECRET` continuam os do seu `.env` atual — não têm nada a ver com o
   banco.


2. **Pare o `npm run dev`** (um servidor por vez, senão o `.next` corrompe e o socket do WhatsApp
   cai) e gere o client para Postgres:

   ```
   npm run db:generate
   ```

   Este é o momento em que o client SQLite sai de cena. Depois dele, o CRM só funciona com o
   Supabase acessível.

3. **Aplique o schema:**

   ```
   npm run db:deploy
   ```

   `migrate deploy` só cria o que está faltando — ele não destrói tabela nem coluna. Se preferir
   conferir antes: `npm run db:status`.

4. **Confira do lado do app** (o `db:status` fala com o banco de migração; este checa a conexão que o
   CRM usa e se o client gerado bate com o schema):

   ```
   npm run db:check
   ```

   Ele imprime as duas conexões com a senha escondida, a versão do Postgres, a latência de um
   `SELECT 1`, as migrations aplicadas e a contagem de linhas por tabela. É 100% leitura.

### Se o `db:check` reclamar

| Mensagem | O que é | Conserto |
| --- | --- | --- |
| `no tenant identifier provided (external_id or sni_hostname required)` | O `DATABASE_URL` está no pooler com o usuário `postgres` puro. O pooler atende vários projetos no mesmo host e identifica o seu pelo sufixo do usuário (`postgres.<ref>`). Acontece quando se cola a string "legacy"/direta no campo do pooler. | `npx tsx scripts/fix-pooler-user.ts` — troca só o usuário, a senha fica intacta e nunca aparece na tela |
| `tenant/user postgres.<ref> not found` | Não é a senha (o erro vem antes de olhar credencial): o seu projeto **não está registrado naquele pooler**. Na prática é **região errada no host** — a aba *URIs* do painel pode mostrar uma região e o tenant estar em outra; a aba *ORM* mostra a que autentica. (Menos comum: connection pooling desligado no projeto.) | `npx tsx scripts/fix-pooler-user.ts --pooler <região>` reescreve só o host com a região que você indicar, mantendo a senha. Neste projeto: `--pooler us-east-1`. Alternativa enquanto isso: `npx tsx scripts/fix-pooler-user.ts --usar-direta` joga o runtime na conexão direta |
| `EMAXCONNSESSION` / `max clients reached in session mode - max clients are limited to pool_size: 15` | O session pooler do plano gratuito só aceita **15 conexões simultâneas**, e o Prisma abre até `2 × núcleos da CPU + 1` por processo. Com dois `npm run dev` abertos (ou um dev + um script) isso estoura, e a rota que faz 15 queries em paralelo (`/api/dashboard`) é a primeira a tombar. Na tela vira um 500 — e como o `useApi` devolve o corpo do erro como se fosse dado, o dashboard quebrava em `Cannot read properties of undefined (reading 'map')`. | `npx tsx scripts/fix-pooler-user.ts --limite 5` grava `?connection_limit=5` no `DATABASE_URL` (o Prisma enfileira as queries dentro das 5 conexões em vez de abrir mais) e **mantenha um único `npm run dev` por vez** |
| `P1001` / `ECONNREFUSED` / timeout em `db.<ref>.supabase.co` | A conexão direta é IPv6 por padrão; em rede só-IPv4 ela não alcança. | Aponte o `DIRECT_URL` para o session pooler (porta 5432, usuário `postgres.<ref>`) |
| `password authentication failed` / `P1000` | Senha antiga — o reset no painel troca a senha das duas strings. | Re-colar as duas com `npx tsx scripts/setup-supabase-env.ts` |
| `Environment variable not found: DIRECT_URL` | Falta uma das duas no `.env`. | `npm run db:status` confirma qual, e o assistente acima grava as duas |


Depois disso, `npm run dev` e siga o "Primeiro acesso" abaixo.

## Primeiro acesso (o banco vai vazio)

1. Abra `/register` e crie a empresa. Isso já traz junto os 8 templates de mensagem e as regras de
   automação padrão — são criados com a org, não é preciso seed nenhum.
2. **Não rode `npm run db:seed`**: ele grava 3 barbearias de mentira com 100 clientes fictícios. É
   seed de demonstração, não de produção. Desde já ele se recusa a rodar contra banco remoto — só
   passa se você colocar `SEED_ALLOW_REMOTE=1` na frente.
3. Marque a sua conta como administradora da plataforma, para o seletor de empresa funcionar como
   antes:
   ```
   npx tsx --env-file=.env scripts/set-superadmin.ts <seu e-mail>
   ```
   O `--env-file=.env` não é enfeite: o `tsx` por si só **não** lê o `.env` (diferente do `prisma`
   e do `next`, que leem). Sem ele o script reclama que `DATABASE_URL` não existe.

4. Repita o registro para as outras empresas que você opera.

## O que NÃO vai para o Supabase

Isto é a parte que mais pega, então está escrita antes de você ligar:

- **A sessão pareada do WhatsApp fica no disco**, em `baileys_auth_<orgId>/`. Ela é chaveada pelo
  `orgId`, e num banco vazio as empresas ganham `orgId` novo → **a pasta atual não serve para a
  empresa nova**. Você vai precisar reconectar o WhatsApp e ler o QR de novo com o celular.
  Nada se perde do pareamento antigo enquanto você não apagar a pasta.
- **Mídia baixada** (`WhatsAppMedia.url` aponta para caminho local ou data URL) continua em disco.
  O Supabase Storage é um projeto à parte, quando você quiser.
- **`prisma/dev.db`** fica exatamente como está, intocado. Ele deixa de ser lido pelo CRM e passa a
  ser o arquivo de onde você pode tirar o histórico velho, se um dia quiser importar.
- **Conversas, clientes e agendamentos que já existem** não migram — você escolheu começar com o
  banco vazio.

## Depois de ligar

- **Latência**: cada consulta atravessa a internet. A Agenda e o painel do WhatsApp fazem polling a
  cada 5s, então o painel pode dar uma travadinha. Se incomodar, o primeiro ajuste é no polling, não
  no banco.
- **Limite de conexão**: o session pooler do plano free atende ~15–60 conexões. Um processo do Next
  local usa poucas. Se aparecer `too many connections`, feche o Prisma Studio e adicione
  `?connection_limit=5` ao `DATABASE_URL`.
- **Mudanças de schema no futuro**: `npx prisma migrate dev --name <nome>` precisa de uma *shadow
  database* (um banco vazio temporário que o Prisma cria). No Supabase isso nem sempre passa pelo
  pooler; o caminho tranquilo é criar um schema à parte para ela, ou então editar o SQL na mão:
  gere a diff com `npx prisma migrate diff --from-migrations prisma/migrations
  --to-schema-datamodel prisma/schema.prisma --script`, salve como pasta nova em
  `prisma/migrations/<timestamp>_<nome>/migration.sql` e rode `npm run db:deploy`. Evite `db push`
  num banco que já tem dados de clientes.

- **Backup**: o Supabase no plano free faz snapshot diário de 7 dias. O `db:reset` está no
  `package.json` e apaga tudo — não rode nele.

## Voltar para o SQLite (se precisar)

1. `provider = "sqlite"` no `schema.prisma` e `DATABASE_URL="file:./dev.db"`.
2. Trocar `prisma/migrations` pela pasta `prisma/migrations_sqlite` (o `migration_lock.toml` dela
   precisa dizer `provider = "sqlite"`).
3. `npm run db:generate`. O `containsCI` detecta o `file:` sozinho e volta a mandar só o
   `contains`, sem `mode`.

O `dev.db` nunca foi tocado, então nada se perde ao voltar.
