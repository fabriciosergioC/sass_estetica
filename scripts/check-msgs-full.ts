import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // Verificar todas as mensagens da Barbearia Imperial
  const msgs = await db.whatsAppMessage.findMany({
    where: { orgId: 'cmuqps9by0001w6uovq91q77x' },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  console.log('Total mensagens:', msgs.length);

  const byStatus: Record<string, number> = {};
  for (const m of msgs) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
  }
  console.log('Por status:', byStatus);

  // Mostrar últimas 20
  console.log('\nÚltimas 20 mensagens:');
  msgs.slice(0, 20).forEach(m => console.log('  ', m.id, m.status, m.direction, m.phone, m.body?.slice(0,60), 'template:', m.templateKey, 'error:', m.error));

  // Verificar jobs
  const jobs = await db.job.findMany({
    where: { orgId: 'cmuqps9by0001w6uovq91q77x' },
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  console.log('\nJobs:', jobs.length);
  jobs.forEach(j => console.log('  ', j.id, j.type, j.status, j.runAt, j.attempts, '/', j.maxAttempts, 'error:', j.lastError));

  // Verificar templates
  const templates = await db.messageTemplate.findMany({
    where: { orgId: 'cmuqps9by0001w6uovq91q77x' }
  });
  console.log('\nTemplates:', templates.length);
  templates.forEach(t => console.log('  ', t.key, t.enabled, t.body.slice(0,60)));
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());