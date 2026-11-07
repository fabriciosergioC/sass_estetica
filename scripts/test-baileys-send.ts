import { PrismaClient } from "@prisma/client";
import { getWhatsAppProvider } from "@/modules/whatsapp/provider";
import { enqueueJob } from "@/modules/automation/jobs";

const db = new PrismaClient();

async function main() {
  const orgId = "cmuqps9by0001w6uovq91q77x"; // Barbearia Imperial

  console.log("🧪 Testando envio real via Baileys...\n");

  // 1. Verificar conexão
  const conn = await db.whatsAppConnection.findUnique({ where: { orgId } });
  console.log("Conexão:", conn);

  if (!conn || conn.provider !== "baileys") {
    console.log("❌ Provider não é Baileys. Execute scripts/setup-baileys.ts primeiro");
    return;
  }

  if (conn.status !== "CONNECTED") {
    console.log("❌ Baileys não está CONECTADO. Conecte primeiro via interface web.");
    return;
  }

  // 2. Buscar um cliente com opt-in
  const customer = await db.customer.findFirst({
    where: { orgId, whatsappOptIn: true },
  });

  if (!customer) {
    console.log("❌ Nenhum cliente com whatsappOptIn=true encontrado");
    return;
  }

  console.log(`✅ Cliente: ${customer.name} (${customer.phone})`);

  // 3. Testar envio direto via provedor
  console.log("\n📤 Testando provedor Baileys diretamente...");
  const provider = getWhatsAppProvider("baileys");
  const result = await provider.sendMessage(customer.phone, "Teste real via Baileys! 💈");
  console.log("Resultado:", result);

  // 4. Testar fluxo completo (mensagem + job)
  console.log("\n📤 Testando fluxo completo (mensagem + job)...");
  const message = await db.whatsAppMessage.create({
    data: {
      orgId,
      customerId: customer.id,
      direction: "OUT",
      phone: customer.phone,
      body: "Teste fluxo completo via job",
      templateKey: null,
      status: "QUEUED",
    },
  });

  await enqueueJob({ type: "send_whatsapp", payload: { orgId, messageId: message.id } });
  console.log(`✅ Job enfileirado para mensagem: ${message.id}`);
  console.log("   Aguarde alguns segundos e verifique status no painel WhatsApp");
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());