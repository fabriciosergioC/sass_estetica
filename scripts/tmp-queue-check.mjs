// Verificação temporária (modo mock, banco de CÓPIA): envio enfileirado não duplica linha.
// Rode com: node scripts/tmp-queue-check.mjs  (servidor descartável em http://localhost:3005)
const BASE = "http://localhost:3005";

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "fabricio.sergio672@gmail.com", password: "ApiCheck123" }),
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const H = { "content-type": "application/json", cookie };
const get = (p) => fetch(`${BASE}${p}`, { headers: H }).then((r) => r.json());
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) }).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Conecta o mock e espera ficar CONNECTED (sem tocar em WhatsApp real).
await post("/api/whatsapp", { action: "connect" });
let state = null;
for (let i = 0; i < 20; i++) {
  const view = await get("/api/whatsapp");
  state = view.connection?.state;
  if (state === "CONNECTED") break;
  await wait(1000);
}
console.log("estado conexão :", state);

// 2) Conversa nova + envio ENFILEIRADO (immediate:false).
const conv = await post("/api/whatsapp/conversations", {
  phone: "5531981234567",
  name: "Prova de fila",
});
const antes = await get(`/api/whatsapp/messages?conversationId=${conv.conversationId}`);
const send = await post("/api/whatsapp/messages", {
  conversationId: conv.conversationId,
  body: "Mensagem que passou pela fila de envios.",
  immediate: false,
});
console.log("resposta POST  :", JSON.stringify(send));

// 3) Espera o worker da fila (ciclo de 5s) entregar.
const vistos = [];
for (let i = 0; i < 24; i++) {
  await wait(2500);
  const after = await get(`/api/whatsapp/messages?conversationId=${conv.conversationId}`);
  const mine = after.items.find((m) => m.id === send.messageId);
  vistos.push(`${i}:${mine?.status ?? "?"}/x${after.total}`);
  if (mine && (mine.status === "DELIVERED" || mine.status === "READ" || mine.status === "SENT" || mine.status === "FAILED")) break;
}
console.log("transições     :", vistos.join(" "));

const after = await get(`/api/whatsapp/messages?conversationId=${conv.conversationId}`);
console.log("linhas na conversa :", after.total, "(esperado 1 — sem linha duplicada)");
console.log(
  "mensagem         :",
  after.items.map((m) => `${m.status}/${m.direction}/${m.body.slice(0, 34)}${m.error ? " /erro=" + m.error : ""}`).join(" || ")
);

const q = await get("/api/whatsapp/queue");
console.log("fila             :", JSON.stringify({ messages: q.messages, jobs: q.jobs, paused: q.paused, upcoming: q.upcoming?.length }));
