import { db } from "./src/lib/db";

async function main() {
  const templates = await db.messageTemplate.findMany({
    where: { orgId: 'cmvy7gg030001w6jkumr8cd8b' },
    select: { key: true, enabled: true, body: true }
  });
  console.log('Templates:', JSON.stringify(templates, null, 2));
  await db.$disconnect();
}

main();