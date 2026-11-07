import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const msgs = await db.whatsAppMessage.findMany({
    where: { orgId: 'cmuqps9by0001w6uovq91q77x' },
    orderBy: { createdAt: 'desc' },
    take: 20
  });
  console.log('Mensagens Barbearia Imperial:', msgs.length);
  msgs.forEach(m => console.log('  ', m.id, m.status, m.direction, m.phone, m.body?.slice(0,50), 'template:', m.templateKey, 'error:', m.error));
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());