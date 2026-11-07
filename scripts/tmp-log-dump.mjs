import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:./api-check.db" } } });
const ids = ["cmvpsllib0001w62w7j0rnzzj", "cmvpskb2s0008w6ck1ehjcyk3"];
const msgs = await db.whatsAppMessage.findMany({ where: { id: { in: ids } } });
for (const m of msgs) console.log(JSON.stringify({ id: m.id, status: m.status, error: m.error, sentAt: m.sentAt, updatedAt: m.updatedAt, conn: m.connectionId, phone: m.phone }));
const logs = await db.whatsAppLog.findMany({ where: { createdAt: { gte: new Date("2026-10-28T03:40:00Z") } }, orderBy: { createdAt: "asc" }, take: 60 });
for (const l of logs) console.log(l.createdAt.toISOString(), l.level, l.event, "|", (l.actor ?? "-"), "|", (l.detail ?? "-").slice(0, 90));
await db.$disconnect();
