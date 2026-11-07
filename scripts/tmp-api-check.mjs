// Verificação temporária (modo mock, banco de cópia): integridade UTF-8 + status dos envios.
// Rode com: node scripts/tmp-api-check.mjs  (servidor em http://localhost:3005)
const BASE = "http://localhost:3005";

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "fabricio.sergio672@gmail.com", password: "ApiCheck123" }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const H = { "content-type": "application/json", cookie };

const texto = "Olá, atenção! É a {{empresa}} — orçamento R$ 120, validação çãõ.";
const criado = await fetch(`${BASE}/api/whatsapp/quick-replies`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ shortcut: "orcamento", body: texto, title: "Orçamento çãõ" }),
});
const { reply } = await criado.json();
const lido = await (await fetch(`${BASE}/api/whatsapp/quick-replies`, { headers: H })).json();
const salvo = lido.items.find((r) => r.id === reply.id);
console.log("UTF-8 enviado  :", texto);
console.log("UTF-8 gravado  :", salvo?.body);
console.log("idêntico       :", salvo?.body === texto);

// Conversa + envio imediato, depois relê o status real.
const conv = await (
  await fetch(`${BASE}/api/whatsapp/conversations`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ phone: "5531987654321", name: "Verificação UTF-8" }),
  })
).json();

const send = await (
  await fetch(`${BASE}/api/whatsapp/messages`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ conversationId: conv.conversationId, body: "Boa tarde! Tudo certo? {{nome}}" }),
  })
).json();
console.log("envio imediato :", JSON.stringify(send));

await new Promise((r) => setTimeout(r, 2500));
const msgs = await (await fetch(`${BASE}/api/whatsapp/messages?conversationId=${conv.conversationId}`, { headers: H })).json();
console.log(
  "mensagens      :",
  msgs.items.map((m) => `${m.direction}/${m.status}/${m.body.slice(0, 30)}${m.error ? "/" + m.error : ""}`).join(" || ")
);

// Histórico antigo (mensagens sem conversa) — o que o backfill precisa cobrir.
const órfãs = await (await fetch(`${BASE}/api/whatsapp/messages?pageSize=100`, { headers: H })).json();
const semConversa = órfãs.items.filter((m) => !m.conversationId);
console.log("total msgs     :", órfãs.total, "| sem conversa:", semConversa.length);
console.log(
  "exemplos       :",
  semConversa.slice(0, 6).map((m) => `${m.phone}/${m.status}/${m.direction}`).join(" || ")
);
