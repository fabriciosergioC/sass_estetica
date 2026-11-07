/**
 * Estado da fila de WhatsApp agora: mensagens QUEUED, jobs PENDING e a pausa ativa.
 * Só leitura. Uso: npx tsx --env-file=.env scripts/fila-wa.ts [slug]
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const slug = process.argv[2] || "bela-face";

function h(d: Date | null): string {
  return d ? new Date(d).toLocaleString("pt-BR", { hour12: false }) : "—";
}

async function main() {
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org) return console.log(`organização ${slug} não encontrada`);

  const [queued, jobs, pauseRow] = await Promise.all([
    db.whatsAppMessage.findMany({
      where: { orgId: org.id, direction: "OUT", status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      take: 20,
    }),
    db.job.findMany({
      where: { orgId: org.id, type: "send_whatsapp", status: { in: ["PENDING", "PROCESSING"] } },
      orderBy: { runAt: "asc" },
      take: 20,
    }),
    db.systemSetting.findUnique({ where: { key: `whatsapp.pause.${org.id}` } }),
  ]);

  console.log(`\n${org.name} — fila de envio`);
  console.log(`  mensagens QUEUED: ${queued.length}`);
  for (const m of queued) {
    console.log(`    ${(m.templateKey ?? "manual").padEnd(14)} criada ${h(m.createdAt)} | ${m.body.replace(/\s+/g, " ").slice(0, 90)}`);
  }
  console.log(`  jobs de envio na fila: ${jobs.length}`);
  for (const j of jobs) console.log(`    roda ${h(j.runAt)} (${j.status})`);
  console.log(`  fila pausada: ${pauseRow?.value ?? "não"}`);
  console.log("");
}

main()
  .catch((e) => console.error(e))
  .finally(() => db.$disconnect());
