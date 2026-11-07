import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:./api-check.db" } } });
const jobs = await db.job.findMany({ where: { type: "send_whatsapp" }, orderBy: { createdAt: "desc" }, take: 10 });
for (const j of jobs) console.log(j.id, j.status, "attempts=" + j.attempts, "runAt=" + j.runAt.toISOString(), "err=" + (j.lastError ?? "-"));
const msgs = await db.whatsAppMessage.groupBy({ by: ["status"], where: { direction: "OUT" }, _count: true });
console.log("OUT por status:", JSON.stringify(msgs));
await db.$disconnect();
