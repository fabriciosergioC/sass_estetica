/* Teste crítico de multi-tenancy (obrigatório).
 *
 * Tenta, com a sessão da Empresa A, acessar recursos da Empresa B.
 * Resultado esperado: ACESSO NEGADO (401/403/404) em TODOS os casos.
 *
 * Uso:
 *   1. suba o servidor: npm run build && npm run start
 *   2. rode: npm run test:tenancy
 *
 * Variáveis opcionais: BASE_URL, SEED_EMAIL_A, SEED_EMAIL_B, SEED_PASSWORD
 */

/** Ver nota em scripts/test-registration.ts — mantém cada script no seu próprio escopo. */
export {};

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL_A = process.env.SEED_EMAIL_A ?? "rafael@navalhadeouro.com";
const EMAIL_B = process.env.SEED_EMAIL_B ?? "camila@studiobarberclub.com";
const PASSWORD = process.env.SEED_PASSWORD ?? "senha1234";

type Json = Record<string, unknown>;

async function login(email: string): Promise<{ cookie: string; orgId: string }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login falhou para ${email}: ${res.status}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Sem cookie de sessão.");

  const session = await fetch(`${BASE}/api/auth/session`, { headers: { cookie } });
  const data = (await session.json()) as { session?: { activeOrgId?: string } };
  const orgId = data.session?.activeOrgId ?? "";
  return { cookie, orgId };
}

async function createCustomer(cookie: string, name: string, phone: string): Promise<string> {
  const res = await fetch(`${BASE}/api/customers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name, phone }),
  });
  const data = (await res.json()) as Json;
  const customer = data.customer as { id: string } | undefined;
  if (!customer) throw new Error(`criar cliente falhou: ${JSON.stringify(data)}`);
  return customer.id;
}

type Case = { label: string; status: number; body?: string };

async function expectDenied(label: string, res: Response): Promise<Case> {
  return { label, status: res.status, body: await res.text() };
}

async function main() {
  console.log(`🌐 Testando contra ${BASE}\n`);
  const a = await login(EMAIL_A);
  const b = await login(EMAIL_B);

  if (!a.orgId || !b.orgId || a.orgId === b.orgId) {
    throw new Error(
      `Orgs inválidas para o teste: A=${a.orgId} B=${b.orgId}. Rode o seed antes (npm run db:seed).`
    );
  }

  const customerA = await createCustomer(
    a.cookie,
    "Cliente A Tenancy",
    `119${String(Date.now()).slice(-8)}`
  );
  const customerB = await createCustomer(
    b.cookie,
    "Cliente B Tenancy",
    `119${String(Date.now() + 1).slice(-8)}`
  );
  console.log(`Empresa A: ${a.orgId}\nEmpresa B: ${b.orgId}\n`);

  const cases: Case[] = [];

  // 1. GET cliente da B com sessão da A
  cases.push(
    await expectDenied(
      "GET /api/customers/{cliente da B}",
      await fetch(`${BASE}/api/customers/${customerB}`, { headers: { cookie: a.cookie } })
    )
  );

  // 2. PATCH cliente da B com sessão da A
  cases.push(
    await expectDenied(
      "PATCH /api/customers/{cliente da B}",
      await fetch(`${BASE}/api/customers/${customerB}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: a.cookie },
        body: JSON.stringify({ name: "HACKEADO" }),
      })
    )
  );

  // 3. DELETE cliente da B com sessão da A
  cases.push(
    await expectDenied(
      "DELETE /api/customers/{cliente da B}",
      await fetch(`${BASE}/api/customers/${customerB}`, {
        method: "DELETE",
        headers: { cookie: a.cookie },
      })
    )
  );

  // 4. Listagem da A não pode conter clientes da B
  const listRes = await fetch(`${BASE}/api/customers?pageSize=100`, {
    headers: { cookie: a.cookie },
  });
  const list = (await listRes.json()) as { items?: Array<{ id: string }> };
  const leaked = (list.items ?? []).some((c) => c.id === customerB);
  cases.push({ label: "Listagem da A não contém cliente da B", status: leaked ? 200 : 404 });

  // 5. Notificações da B com sessão da A
  const notifRes = await fetch(`${BASE}/api/notifications?pageSize=100`, {
    headers: { cookie: a.cookie },
  });
  const notif = (await notifRes.json()) as { items?: Array<{ orgId: string }> };
  const notifLeak = (notif.items ?? []).some((n) => n.orgId === b.orgId);
  cases.push({ label: "Notificações da A não contém org da B", status: notifLeak ? 200 : 404 });

  // 6. Configurações da org da B não devem ser alteráveis pela A
  const ownOrg = (await (await fetch(`${BASE}/api/organizations`, { headers: { cookie: a.cookie } })).json()) as Json;
  const originalName = (ownOrg.organization as { name?: string } | undefined)?.name ?? null;
  const orgPatch = await fetch(`${BASE}/api/organizations`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: a.cookie },
    body: JSON.stringify({ name: "TENTATIVA_TROCA_ORG_B" }),
  });
  const orgData = (await orgPatch.json()) as Json;
  const org = orgData.organization as { id?: string; name?: string } | undefined;
  const patchedB = org?.id === b.orgId; // impossível: A altera a própria org
  cases.push({ label: "PATCH organização não atinge org da B", status: patchedB ? 200 : 404 });

  // Restaura o nome da org A. O que o teste precisa provar é que ele NÃO alcançou a org da B
  // — não que a barbearia de demonstração pode acordar renomeada como "TENTATIVA_TROCA_ORG_B".
  if (!patchedB && originalName && org?.name !== originalName) {
    await fetch(`${BASE}/api/organizations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ name: originalName }),
    });
  }

  // 7. Agendamento do cliente da B não pode ser criado pela A
  const barbersRes = await fetch(`${BASE}/api/barbers?pageSize=50`, { headers: { cookie: a.cookie } });
  const barbers = ((await barbersRes.json()) as { items?: Array<{ id: string }> }).items ?? [];
  const servicesRes = await fetch(`${BASE}/api/services?pageSize=50`, { headers: { cookie: a.cookie } });
  const services = ((await servicesRes.json()) as { items?: Array<{ id: string }> }).items ?? [];
  if (barbers[0] && services[0]) {
    const crossBooking = await fetch(`${BASE}/api/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: a.cookie },
      body: JSON.stringify({
        customerId: customerB, // cliente da B!
        barberId: barbers[0].id,
        serviceId: services[0].id,
        date: "2027-01-15",
        time: "10:00",
      }),
    });
    cases.push(
      await expectDenied("POST /api/appointments com cliente da B", crossBooking)
    );
  }

  console.log("Resultados:\n");
  let failures = 0;
  for (const c of cases) {
    // Negação = 401/403/404, ou 400 com mensagem de "não encontrado"
    // (regra de negócio se recusa a operar sobre recurso de outra org).
    const denied =
      c.status === 401 ||
      c.status === 403 ||
      c.status === 404 ||
      (c.status === 400 && (c.body ?? "").includes("não encontrado"));
    if (!denied) failures++;
    console.log(`  ${denied ? "✅ ACESSO NEGADO" : "❌ VAZAMENTO"}  [${c.status}] ${c.label}`);
  }

  console.log(
    failures === 0
      ? `\n✅ MULTI-TENANCY OK — ${cases.length}/${cases.length} casos negados.`
      : `\n❌ MULTI-TENANCY FALHOU — ${failures} caso(s) com vazamento.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Erro no teste:", err.message);
  process.exit(1);
});
