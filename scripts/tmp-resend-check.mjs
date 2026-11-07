const BASE = "http://localhost:3005";
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fabricio.sergio672@gmail.com", password: "ApiCheck123" }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const H = { "content-type": "application/json", cookie };
const get = (p) => fetch(`${BASE}${p}`, { headers: H }).then((r) => r.json());
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) }).then(async (r) => ({ http: r.status, json: await r.json() }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) pega uma FAILED presa (a que o reconcile marcou)
const falhas = await get("/api/whatsapp/messages?status=FAILED&pageSize=30");
const alvo = falhas.items.find((m) => (m.error ?? "").startsWith("A fila perdeu"));
console.log("alvo           :", alvo ? `${alvo.id} | ${alvo.phone} | ${alvo.error}` : "nenhuma");
if (!alvo) process.exit(0);

// 2) reconecta o mock para o reenvio ter chance de dar certo
await post("/api/whatsapp", { action: "connect" });
for (let i = 0; i < 15; i++) { const v = await get("/api/whatsapp"); if (v.view?.state === "CONNECTED") break; await wait(1000); }
const v0 = await get("/api/whatsapp");
console.log("conexão        :", (v0.view?.state ?? v0.connection?.status), "| mock:", v0.mock);

// 3) reenvio (linha mesma, via fila)
const r = await post(`/api/whatsapp/messages/${alvo.id}`, { action: "resend" });
console.log("resend HTTP    :", r.http, JSON.stringify(r.json));

const antes = await get(`/api/whatsapp/messages?conversationId=${alvo.conversationId}&pageSize=100`);
console.log("linhas conversa:", antes.total);

for (let i = 0; i < 12; i++) {
  await wait(2500);
  const one = await get(`/api/whatsapp/messages/${alvo.id}`);
  const s = one.message?.status;
  console.log("  status       :", s, one.message?.error ?? "", "| sentAt:", one.message?.sentAt ?? "-");
  if (s && s !== "QUEUED") break;
}
const depois = await get(`/api/whatsapp/messages?conversationId=${alvo.conversationId}&pageSize=100`);
console.log("linhas conversa depois:", depois.total, "(tem que ser igual a", antes.total + ")");
const q = await get("/api/whatsapp/queue");
console.log("fila           :", JSON.stringify({ messages: q.messages, jobs: q.jobs, paused: q.paused }));
