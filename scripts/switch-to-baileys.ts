import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// ID da Barbearia Imperial (que tem status CONNECTED no DEV)
const ORG_ID = "cmuqps9by0001w6uovq91q77x";

async function main() {
  console.log("🔧 Alterando provider para Baileys...\n");

  // 1. Verificar estado atual
  const conn = await db.whatsAppConnection.findUnique({ where: { orgId: ORG_ID } });
  console.log("Estado atual:", conn);

  // 2. Atualizar para Baileys
  const updated = await db.whatsAppConnection.update({
    where: { orgId: ORG_ID },
    data: { provider: "baileys", status: "DISCONNECTED" },
  });

  console.log("\n✅ Provider alterado com sucesso:");
  console.log("   Provider:", updated.provider);
  console.log("   Status:", updated.status);
  console.log("\n📋 Próximos passos:");
  console.log("   1. Acesse o painel da Barbearia Imperial");
  console.log("   2. Vá em Configurações → WhatsApp");
  console.log("   3. Clique em 'Conectar' (ou faça POST /api/whatsapp com {action:'connect'})");
  console.log("   4. Escaneie o QR Code com seu WhatsApp");
  console.log("   5. Aguarde status CONNECTED");
  console.log("\n⚠️  IMPORTANTE: O Baileys precisa do servidor rodando (npm run dev)");
  console.log("   O QR Code aparece no terminal onde o servidor está rodando");
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());