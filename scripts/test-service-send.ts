import { sendMessage } from "../src/modules/whatsapp/service";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const orgId = "cmuqps9by0001w6uovq91q77x";
  console.log("Enviando mensagem via WhatsAppService...");
  const result = await sendMessage({
    orgId,
    phone: "5531987707962",
    body: "Olá! Teste de entrega corrigido com sucesso via Barbearia Imperial. 💈",
    immediate: true,
  });

  console.log("Resultado de sendMessage:", result);

  console.log("Aguardando 10s para verificar se recibos de entrega foram gravados...");
  await new Promise((r) => setTimeout(r, 10000));

  const msg = await db.whatsAppMessage.findUnique({
    where: { id: result.messageId },
  });
  console.log("Mensagem final no banco:", {
    id: msg?.id,
    phone: msg?.phone,
    status: msg?.status,
    sentAt: msg?.sentAt,
    deliveredAt: msg?.deliveredAt,
    readAt: msg?.readAt,
    error: msg?.error,
  });
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
