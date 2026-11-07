const BASE = "http://localhost:3005";
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fabricio.sergio672@gmail.com", password: "ApiCheck123" }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const H = { "content-type": "application/json", cookie };
const q = await (await fetch(`${BASE}/api/whatsapp/queue`, { headers: H })).json();
console.log("upcoming jobs:", JSON.stringify(q.upcoming));
const msgs = await (await fetch(`${BASE}/api/whatsapp/messages?status=QUEUED&pageSize=20`, { headers: H })).json();
console.log("QUEUED msgs  :", msgs.total);
for (const m of msgs.items) console.log(" -", m.id, m.direction, m.status, (m.phone ?? "-"), "|", (m.body ?? "").slice(0, 40), "| conv:", m.conversationId ?? "null", "| criada:", m.createdAt);
