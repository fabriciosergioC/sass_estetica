import { PrismaClient } from "@prisma/client";
const db = new PrismaClient({ datasources: { db: { url: "file:./api-check.db" } } });
const jobs = await db.job.findMany({ where: { id: { in: ["cmvrknsx2001cw6qoawiy4cpo", "cmvrkzqx0002aw6zkjtc5o2db"] } } });
for (const j of jobs) {
  const mid = JSON.parse(j.payload).messageId;
  const m = await db.whatsAppMessage.findUnique({ where: { id: mid }, select: { id: true, status: true, error: true, body: true, updatedAt: true } });
  console.log("job", j.id, j.status, "attempts", j.attempts, "max", j.maxAttempts, "err", j.lastError);
  console.log("   msg:", JSON.stringify(m));
}
// QUEUED sem job pendente = mensagem fantasma (nunca envia, nunca erro)
const queued = await db.whatsAppMessage.findMany({ where: { direction: "OUT", status: "QUEUED" }, select: { id: true, createdAt: true } });
for (const q of queued) {
  const job = await db.job.findFirst({ where: { type: "send_whatsapp", status: { in: ["PENDING", "PROCESSING"] } }, select: { id: true, payload: true } });
  const has = (await db.job.findMany({ where: { type: "send_whatsapp" }, select: { payload: true, status: true } })).some((j) => JSON.parse(j.payload).messageId === q.id && ["PENDING", "PROCESSING"].includes(j.status));
  console.log("QUEUED", q.id, q.createdAt.toISOString(), has ? "tem job pendente" : "*** SEM JOB (fantasma) ***");
}
await db.$disconnect();
