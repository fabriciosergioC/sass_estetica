import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const conversations = await db.whatsAppConversation.findMany({
    include: {
      contact: {
        select: {
          name: true,
          phone: true,
        },
      },
    },
    orderBy: {
      lastMessageAt: 'desc',
    },
  });

  console.log("Conversas WhatsApp:");
  conversations.forEach((c) => {
    console.log(`Conv ID: ${c.id} | Contact ID: ${c.contactId} | Nome: ${c.contact.name || 'Sem nome'} | Telefone: ${c.contact.phone || 'Sem telefone'} | Última msg: ${c.lastMessageAt}`);
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
