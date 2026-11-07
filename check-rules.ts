import { db } from "./src/lib/db";

async function main() {
  const rules = await db.automationRule.findMany({
    where: { enabled: true },
    select: { id: true, orgId: true, event: true, action: true, config: true }
  });
  console.log("Regras ativas:", JSON.stringify(rules, null, 2));
  await db.$disconnect();
}

main();
