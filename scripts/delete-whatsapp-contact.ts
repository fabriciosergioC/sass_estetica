import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const contactId = "cmvrubfbm000rw6psapxakuna";
  console.log(`Deletando contato ${contactId}...`);

  const result = await db.whatsAppContact.delete({
    where: {
      id: contactId,
    },
  });

  console.log(`Contato deletado com sucesso:`, result);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
