import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const org = await db.organization.findFirst({
    where: {
      OR: [
        { address: { contains: "Mariópolis" } },
        { phone: "31992154970" },
      ],
    },
  });

  if (!org) {
    console.log("Organização não encontrada.");
    return;
  }

  console.log("Organização encontrada:", org.name);
  console.log("Endereço atual:", org.address);
  console.log("Telefone atual:", org.phone);

  await db.organization.update({
    where: { id: org.id },
    data: {
      address: null,
      phone: null,
    },
  });

  console.log("Endereço e telefone removidos com sucesso.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());