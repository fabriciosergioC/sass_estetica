# 💈 SaaS Barbearia

Plataforma SaaS multi-tenant para barbearias: **Agenda + CRM + Automação + WhatsApp + Inteligência Operacional**.

Uma única instância atende centenas de barbearias, com isolamento completo de dados por empresa.

---

## 🧭 Visão geral

| Módulo | O que faz |
|---|---|
| **Agenda inteligente** | Dia/semana, por barbeiro, conflitos bloqueados no backend, status com máquina de transições |
| **Agendamento público** | Página `/b/[slug]` com fluxo em 5 passos, sem login, com rate limit |
| **CRM** | Ficha do cliente com timeline, métricas derivadas (frequência, recência, valor, risco) |
| **WhatsApp** | Camada `WhatsAppService` + adapter (`bariels` = WhatsApp Web/Baileys, `mock` = teste), painel de conversas, fila espaçada e templates editáveis |
| **Motor de automação** | Eventos de domínio → regras → ações (send_whatsapp, schedule_reminder, notify_admin, create_opportunity) |
| **Fila de jobs** | Persistida no banco, retry com backoff, dead-letter, processada pós-resposta ou via cron |
| **Anti-faltas** | Score de risco 0–100 baseado em faltas/cancelamentos reais |
| **Oportunidades** | Horário ocioso, retorno atrasado, cliente inativo, risco de falta — sempre com evidência e ação |
| **Central de Inteligência** | Dashboard com resumo acionável do dia |
| **Multi-tenancy** | `orgId` em todas as entidades, validado no backend em toda consulta |
| **Auditoria** | `audit_logs` com usuário, ação, entidade, antes/depois |

---

## 🚀 Início rápido

```bash
# 1. Instalar dependências
npm install

# 2. Configurar ambiente
cp .env.example .env
# Edite DATABASE_URL + DIRECT_URL (Supabase), SESSION_SECRET (mínimo 32 chars) e CRON_SECRET

# 3. Banco de dados (Postgres do Supabase — passo a passo em SUPABASE.md)
npm run db:generate  # gera o Prisma Client para Postgres
npm run db:deploy    # aplica o schema
npm run db:seed      # OPCIONAL: dados fictícios (3 barbearias, 100+ clientes). Não rode num
                     # banco que vai receber clientes de verdade.

# 4. Executar
npm run dev          # http://localhost:3000
```

**Login após seed:** `rafael@navalhadeouro.com` / `senha1234`

### 🪟 Windows: `iniciar.bat`

No Windows, duplo clique em [`iniciar.bat`](iniciar.bat) abre um menu interativo:

```
[1] Iniciar sistema (desenvolvimento)   → npm run dev (http://localhost:3000)
[2] Instalar / atualizar dependências   → npm install
[3] Configurar banco                    → migrate + seed
[4] Build + Start (produção)            → npm run build + npm start
[5] Abrir Prisma Studio
[6] Typecheck
[7] Teste de multi-tenancy
[0] Sair
```

Na primeira execução ele cria o `.env` (copiando de `.env.example`) e instala dependências se `node_modules` não existir.

Ele **não** mexe no banco: `iniciar.ps1` só confere se `DATABASE_URL`/`DIRECT_URL` estão no `.env`,
e aplica migrations apenas com `DB_AUTOSYNC=1`. É de propósito — o banco agora é o Postgres do
Supabase, e um `db push --accept-data-loss` automático no boot poderia derrubar coluna com dados de
clientes dentro. Rode `npm run db:deploy` quando quiser aplicar schema.

> Nota: o `.bat` é ASCII puro e usa `pause`/`set /p` nativos do `cmd` — evite adicionar `chcp 65001` ou acentos, pois isso quebra a leitura de entrada no `cmd.exe`.

### Comandos

| Comando | Descrição |
|---|---|
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` | Build de produção |
| `npm start` | Servidor de produção |
| `npm run typecheck` | Verificação de tipos |
| `npm run db:generate` | Regenera o Prisma Client (depois de mexer no schema) |
| `npm run db:migrate` | Cria/aplica migration em ambiente de desenvolvimento |
| `npm run db:deploy` | Aplica as migrations pendentes (o comando do dia a dia) |
| `npm run db:status` | Mostra o que está pendente, sem escrever nada |
| `npm run db:check` | Confere a conexão que o **app** usa: latência, migrations aplicadas, contagem por tabela (somente leitura) |
| `npm run db:seed` | Seed de demonstração (dados fictícios) — recusa banco remoto, salvo `SEED_ALLOW_REMOTE=1` |
| `npm run db:reset` | Reset completo do banco |
| `npm run db:studio` | Prisma Studio |
| `npm run test:tenancy` | **Teste crítico de multi-tenancy** (requer servidor rodando) |

---

## 🔐 Variáveis de ambiente

Nunca coloque secrets no código. Veja `.env.example`.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | ✅ | Connection string do Supabase que a **aplicação** usa (session pooler, porta 5432) |
| `DIRECT_URL` | ✅ | Conexão **direta** do mesmo projeto, usada só pelas migrations |
| `SESSION_SECRET` | ✅ | Segredo HS256 do cookie de sessão (mín. 32 chars) |
| `CRON_SECRET` | para cron | Segredo da rota `POST /api/cron` |
| `WHATSAPP_PROVIDER` | ✅ | `bariels` (WhatsApp Web / Baileys) — ver [BAILEYS_SETUP.md](BAILEYS_SETUP.md). `evolution` \| `meta_cloud` \| `zapi` ainda não têm adapter |
| `WHATSAPP_MOCK` | para testes | `1` simula o WhatsApp do começo ao fim, sem parear aparelho |
| `EVOLUTION_*` / `META_*` / `ZAPI_*` | futuro | Chaves reservadas; nenhum adapter as lê hoje |

---

## 🏗️ Arquitetura

```
src/
├── app/
│   ├── (auth)/            login, registro
│   ├── api/               rotas REST (auth, appointments, customers, ..., cron)
│   ├── app/               painel autenticado (dashboard, agenda, clientes, ...)
│   └── b/[slug]/          página pública de agendamento
├── modules/
│   ├── scheduling/        availability + appointments (regras de negócio)
│   ├── automation/        events (motor) + jobs (fila)
│   ├── whatsapp/          provider (abstração) + messages (templates/envio)
│   ├── crm/               metrics (segmentos, risco)
│   ├── intelligence/      opportunities (detecção explicável)
│   └── organizations/     provisionamento de tenant
├── lib/                   db, api helpers, auth (session/guards/permissions)
└── components/            ui, sidebar, toast, dialog
prisma/
├── schema.prisma          30+ modelos, todos com relação com Organization
└── seed.ts                dados fictícios determinísticos
```

### Decisões técnicas

1. **Postgres no Supabase.** O schema usa apenas tipos portáveis (money em centavos `Int`, enums como `String`, datas em UTC), então viermos do SQLite local sem reescrever modelo. A virada está documentada em [SUPABASE.md](SUPABASE.md), e o único ponto que ainda exige cuidado é busca de texto: `containsCI()` em `src/lib/search.ts` resolve a diferença de `LIKE` entre os dois bancos.
2. **Fila de jobs em tabela (não Redis).** Evita infraestrutura extra no estágio atual; `processJobs` é isolado e pode ser movido para worker externo sem mudar chamadores.
3. **`after()` do Next.js** processa jobs logo após a resposta HTTP — nenhuma automação bloqueia o usuário.
4. **Provedor WhatsApp por interface.** `getWhatsAppProvider()` é o único ponto de acoplamento; vendor real = nova classe.
5. **Permissões só no backend.** `requirePermission("...")` em toda rota; a UI apenas esconde botões.
6. **Métricas como cache derivado** (`CustomerMetrics`), recalculadas por job — nunca armazenam dado bruto, sempre derivam do histórico.

---

## 📡 API principais

| Método | Rota | Permissão |
|---|---|---|
| `POST` | `/api/auth/login` \| `register` \| `logout` | pública |
| `GET/POST` | `/api/appointments` | `appointments:read/write` |
| `PATCH/POST` | `/api/appointments/[id]` (remarcar / mudar status) | `appointments:write` |
| `GET/POST` | `/api/customers`, `/api/customers/[id]` | `customers:read/write` |
| `GET` | `/api/availability`, `/api/business-hours` | `appointments:read` |
| `GET/POST` | `/api/opportunities` (detecção + ações) | `opportunities:view` |
| `GET/PATCH` | `/api/automations`, `/api/automations/templates` | `automations:manage` |
| `GET/POST` | `/api/whatsapp`, `/api/whatsapp/test` | `whatsapp:manage` |
| `GET/PATCH` | `/api/notifications` | `appointments:read` |
| `GET/PATCH` | `/api/organizations` | `org:manage` |
| `POST` | `/api/public/[slug]/book` \| `slots` \| `config` | pública (rate-limited) |
| `POST` | `/api/cron` | header `x-cron-secret` |

**Erros:** resposta sempre `{ "error": "mensagem amigável" }` com status apropriado; detalhes técnicos só no log do servidor.

---

## ⚡ Automação: fluxo completo

```
Agendamento criado
  → publishEvent("appointment.created")           [modules/automation/events.ts]
    → regras habilitadas da org
      → send_whatsapp (confirmation)              → WhatsAppMessage QUEUED
      → schedule_reminder (24h antes)             → Job com runAt futuro
  → after() → processJobs()                       [modules/automation/jobs.ts]
    → getWhatsAppProvider().sendMessage()
    → WhatsAppMessage = SENT | FAILED
```

- **Idempotência:** `dedupeKey` única no job; mensagem só sai se ainda estiver `QUEUED`.
- **Cancelamento/remarcação** cancela mensagens pendentes do horário antigo.
- **Retry:** backoff exponencial (2ⁿ min); após `maxAttempts` vira `DEAD` + notificação `AUTOMATION_ERROR`.
- **Lembretes futuros** exigem o cron (abaixo).

### Cron (lembretes + oportunidades)

```bash
curl -X POST http://localhost:3000/api/cron -H "x-cron-secret: $CRON_SECRET"
```

Agende a cada 5–15 min (GitHub Actions, Vercel Cron, crontab):

```cron
*/10 * * * * curl -s -X POST https://sua-app/api/cron -H "x-cron-secret: $CRON_SECRET"
```

---

## 🎯 Oportunidades (inteligência explicável)

Cada oportunidade carrega **problema + evidência + ação sugerida + botão**:

- `IDLE_SLOT` — dia/barbeiro com <60% de ocupação
- `RETURN_DUE` / `INACTIVE_CUSTOMER` — cliente acima do intervalo médio de retorno
- `RISK_APPOINTMENT` — agendamento com score de risco ≥60

Detecção idempotente (não duplica `OPEN` para o mesmo `refId`), expira contexto velho em 7 dias.
Ações reais via API: enviar WhatsApp, recuperar horário, descartar — tudo auditado.

---

## 🔒 Segurança

- Sessão JWT em cookie `httpOnly` + `sameSite=lax`; `tokenVersion` invalida tokens.
- **Todo acesso a dado passa por `requireOrg/requirePermission` com `orgId` da sessão** — nunca do corpo/query.
- Teste obrigatório: `npm run test:tenancy` (7 casos Empresa A → dados da Empresa B; espera 401/403/404).
- Rate limit no agendamento público (8/min por IP).
- Senhas com bcrypt (12 rounds); opt-out de WhatsApp respeitado por cliente (LGPD).
- Anonimização LGPD ao excluir cliente com histórico (mantém agenda, apaga PII).

---

## 📦 Produção

```bash
npm run build
npm start                     # Next.js
# ou: alvo em Docker/VPS com node + nginx
```

Checklist:

- [ ] `SESSION_SECRET` e `CRON_SECRET` forte e distintos
- [ ] `DATABASE_URL` apontando para Postgres gerenciado (backup automático)
- [ ] Cron configurado chamando `/api/cron`
- [ ] `WHATSAPP_PROVIDER` real com credenciais
- [ ] Logs/monitoramento (extensão de `console.error` em `lib/api.ts`)

---

## 🗄️ Banco

30+ entidades, todas multi-tenant (`orgId` + índices compostos):

`organizations, users, organization_members, customers, barbers, services, barber_services, business_hours, appointments, appointment_status_history, customer_notes, customer_metrics, payments, whatsapp_connections, whatsapp_messages, message_templates, automation_rules, automation_executions, jobs, webhook_events, notifications, opportunities, opportunity_actions, audit_logs, plans, subscriptions, system_settings`
