import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("Iniciando a remoção de todas as conversas do WhatsApp...");

  // Como `WhatsAppConversation` tem `onDelete: Cascade` para `WhatsAppMessage`, `WhatsAppConversationLabel`, etc.,
  // deletar as conversas deve limpar tudo automaticamente.

  const result = await db.whatsAppConversation.deleteMany({});

  console.log(`Sucesso! ${result.count} conversas removidas.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
