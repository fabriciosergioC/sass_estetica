import { db } from "./src/lib/db";

async function main() {
  const idsToDelete = [
    "cmvybhg910001w6d89gnl9rk0", // appointment.created -> schedule_reminder (reminder_24h)
    "cmvybhgis0003w6d85norjei1", // appointment.created -> schedule_reminder (reminder_2h)
  ];

  console.log("Removendo regras redundantes de appointment.created...");
  const result = await db.automationRule.deleteMany({
    where: {
      id: { in: idsToDelete }
    }
  });

  console.log(`Foram removidas ${result.count} regras de automação.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
