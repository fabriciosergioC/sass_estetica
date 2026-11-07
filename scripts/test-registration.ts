/* Teste de ponta a ponta do cadastro (Clientes + Serviços), no mesmo estilo do
 * scripts/test-multi-tenancy.ts: fala com o servidor real por HTTP, usando a sessão da barbearia.
 *
 * Cobre exatamente o que a tela faz:
 *   1. salvar um cliente novo (e ele aparecer na lista);
 *   2. recusar o MESMO número de WhatsApp repetido em todos os formatos que ele chega;
 *   3. recusar número repetido também na EDIÇÃO (sem bloquear o próprio número do cliente);
 *   4. salvar um serviço novo pelo botão do formulário.
 *
 * Uso:
 *   1. suba o servidor: npm run dev
 *   2. rode: npx tsx scripts/test-registration.ts
 *
 * Variáveis opcionais: BASE_URL, SEED_EMAIL, SEED_PASSWORD
 * Os registros criados têm telefone derivado do relógio e são APAGADOS no fim.
 */

/** Sem `export {}` o `tsc` trata os dois scripts como globais e eles brigam por
 *  `BASE`/`PASSWORD` com scripts/test-multi-tenancy.ts. */
export {};

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SEED_EMAIL ?? "rafael@navalhadeouro.com";
const PASSWORD = process.env.SEED_PASSWORD ?? "senha1234";

let failures = 0;
const created: { customers: string[]; services: string[] } = { customers: [], services: [] };

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function api(
  cookie: string,
  path: string,
  init: { method: string; body?: unknown }
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: { "Content-Type": "application/json", cookie },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login falhou (${res.status}) para ${EMAIL}. Rode npm run db:seed?`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Resposta de login sem cookie de sessão.");
  return cookie;
}

async function main() {
  console.log(`\nTestando cadastro em ${BASE} como ${EMAIL}\n`);
  const cookie = await login();

  // Número único por execução: permite rodar o teste mais de uma vez sem colidir.
  const mobile = `9${Date.now().toString().slice(-8)}`; // DDD 31 + 9 dígitos
  const variants = {
    comDDI: `5531${mobile}`,
    comDDISimbolo: `+55 (31) ${mobile.slice(0, 4)}-${mobile.slice(4)}`,
    soDDD: `(31) ${mobile.slice(0, 4)}-${mobile.slice(4)}`,
    pontuacao: `55.31.${mobile.slice(0, 4)}-${mobile.slice(4)}`,
    espacos: `55 31 ${mobile.slice(0, 4)} ${mobile.slice(4)}`,
  };

  /* ------------------------------------------------ 1. salvar cliente novo */
  const first = await api(cookie, "/api/customers", {
    method: "POST",
    body: { name: "Teste Cadastro A", phone: variants.comDDI },
  });
  const customerId = first.data?.customer?.id as string | undefined;
  if (customerId) created.customers.push(customerId);
  check("POST /api/customers salva o cliente", first.status === 201 && Boolean(customerId), `status ${first.status}`);

  const listed = await api(cookie, `/api/customers?q=${mobile.slice(4)}&pageSize=50`, { method: "GET" });
  const achouNaLista = (listed.data?.items ?? []).some((c: any) => c.id === customerId);
  check("cliente salvo aparece na busca por número", achouNaLista, `buscou só "${mobile.slice(4)}" (últimos dígitos)`);

  /* ------------------------------------------------ 2. WhatsApp repetido */
  for (const [label, phone] of Object.entries(variants)) {
    const res = await api(cookie, "/api/customers", {
      method: "POST",
      body: { name: `Duplicado ${label}`, phone },
    });
    const apontou = res.data?.conflict?.id === customerId;
    check(
      `recusa número repetido (${label}: ${phone})`,
      res.status === 409,
      `status ${res.status}${apontou ? `, aponta para o cliente já cadastrado` : res.status === 409 ? "" : ` — ${JSON.stringify(res.data)}`}`
    );
  }

  /* ------------------------------------------------ 3. edição */
  const outro = await api(cookie, "/api/customers", {
    method: "POST",
    body: { name: "Teste Cadastro B", phone: `5531${mobile.slice(0, 4)}${mobile.slice(4).split("").reverse().join("")}` },
  });
  const outroId = outro.data?.customer?.id as string | undefined;
  if (outroId) created.customers.push(outroId);
  check("segundo cliente (número diferente) salva", outro.status === 201 && Boolean(outroId), `status ${outro.status}`);

  if (outroId) {
    const colide = await api(cookie, `/api/customers/${outroId}`, {
      method: "PATCH",
      body: { phone: variants.soDDD },
    });
    check("edição não pode tomar o número de outro cliente", colide.status === 409, `status ${colide.status}`);
  }

  if (customerId) {
    const proprio = await api(cookie, `/api/customers/${customerId}`, {
      method: "PATCH",
      body: { name: "Teste Cadastro A", phone: variants.soDDD },
    });
    check("edição continua livre para manter o PRÓPRIO número (só mudou o formato)", proprio.status === 200, `status ${proprio.status}`);

    const incompleto = await api(cookie, `/api/customers/${customerId}`, {
      method: "PATCH",
      body: { phone: "1234" },
    });
    check("telefone incompleto é recusado", incompleto.status === 400 || incompleto.status === 422, `status ${incompleto.status}`);
  }

  /* ------------------------------------------------ 4. serviço novo */
  const servico = await api(cookie, "/api/services", {
    method: "POST",
    body: { name: `Teste Cadastro Serviço ${mobile}`, durationMin: 30, priceCents: 4500, category: "Geral" },
  });
  const serviceId = servico.data?.service?.id as string | undefined;
  if (serviceId) created.services.push(serviceId);
  check("POST /api/services salva o serviço", servico.status === 201 && Boolean(serviceId), `status ${servico.status}`);

  const optIn = await api(cookie, "/api/customers", {
    method: "POST",
    body: { name: "Teste Sem Opt-in", phone: `5531${mobile.slice(0, 3)}${mobile.slice(3).split("").reverse().join("")}`, whatsappOptIn: false },
  });
  if (optIn.data?.customer?.id) created.customers.push(optIn.data.customer.id);
  check("cliente com whatsappOptIn=false salva (LGPD)", optIn.status === 201, `status ${optIn.status}`);
}

async function cleanup(cookie: string) {
  for (const id of created.customers) {
    await api(cookie, `/api/customers/${id}`, { method: "DELETE" }).catch(() => null);
  }
  for (const id of created.services) {
    await api(cookie, `/api/services/${id}`, { method: "DELETE" }).catch(() => null);
  }
  console.log(
    `\nLimpeza: ${created.customers.length} cliente(s) e ${created.services.length} serviço(s) de teste removidos.`
  );
}

main()
  .catch((err) => {
    failures += 1;
    console.error("✗ o teste nem rodou inteiro:", err instanceof Error ? err.message : err);
  })
  .finally(async () => {
    try {
      await cleanup(await login());
    } catch {
      console.log("! não consegui limpar os registros de teste — apague manualmente os " +
        'clientes/serviços chamados "Teste Cadastro".');
    }
    console.log(failures === 0 ? "\nTudo certo.\n" : `\n${failures} verificação(ões) falhou(ram).\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
