const BASE = "http://localhost:3005";
const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fabricio.sergio672@gmail.com", password: "ApiCheck123" }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const H = { cookie };
const f = await (await fetch(`${BASE}/api/whatsapp/messages?status=FAILED&pageSize=30`, { headers: H })).json();
console.log("total FAILED:", f.total);
for (const m of f.items.slice(0, 15)) console.log(" -", m.id, "|", m.phone, "|", (m.error ?? "-").slice(0, 60), "| conv:", m.conversationId ?? "null", "|", m.createdAt);
