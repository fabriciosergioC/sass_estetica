import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const logs = await db.whatsAppLog.findMany({
    where: { orgId: "cmuqps9by0001w6uovq91q77x" },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  console.log("Total logs:", logs.length);
  for (const l of logs) {
    console.log(
      `[${l.createdAt.toISOString()}] [${l.level}] ${l.event} | actor: ${l.actor} | status: ${l.status} | detail: ${l.detail}`
    );
  }
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
