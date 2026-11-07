import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// ID da Barbearia Imperial (que já tinha status CONNECTED no DEV)
const ORG_ID = "cmuqps9by0001w6uovq91q77x";

async function main() {
  console.log("🔧 Configurando Baileys para Barbearia Imperial...\n");

  // 1. Verificar estado atual
  const conn = await db.whatsAppConnection.findUnique({ where: { orgId: ORG_ID } });
  console.log("Estado atual:", conn);

  if (conn?.provider === "baileys") {
    console.log("\n✅ Já está configurado como Baileys");
    return;
  }

  // 2. Atualizar para Baileys
  const updated = await db.whatsAppConnection.update({
    where: { orgId: ORG_ID },
    data: { provider: "baileys", status: "DISCONNECTED" },
  });

  console.log("\n✅ Provider alterado com sucesso:");
  console.log("   Provider:", updated.provider);
  console.log("   Status:", updated.status);
  console.log("\n📋 Próximos passos:");
  console.log("   1. Inicie o servidor: npm run dev");
  console.log("   2. Acesse o painel da Barbearia Imperial");
  console.log("   3. Vá em Configurações → WhatsApp");
  console.log("   4. Clique em 'Conectar'");
  console.log("   5. O QR Code aparecerá:");
  console.log("      - No terminal do servidor (printQRInTerminal)");
  console.log("      - Na interface web (novo componente QRCodeDisplay)");
  console.log("   6. Escaneie com seu WhatsApp: ⋮ → Aparelhos conectados → Conectar aparelho");
  console.log("   7. Aguarde status 'Conectado' (verde)");
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());