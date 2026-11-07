import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const orgId = "cmuqps9by0001w6uovq91q77x"; // Barbearia Imperial

  const conn = await db.whatsAppConnection.findUnique({ where: { orgId } });
  console.log("Conexão atual:", conn);

  if (conn?.provider === "baileys") {
    console.log("\n✅ Provider é Baileys");
    console.log("📋 Para ver o QR Code:");
    console.log("   1. Inicie o servidor: npm run dev");
    console.log("   2. No terminal do servidor, procure por 'QR Code gerado'");
    console.log("   3. Ou acesse: GET /api/whatsapp/qr (retorna base64)");
    console.log("   4. Ou faça POST /api/whatsapp {action:'connect'} e veja o terminal");
  } else {
    console.log("\n⚠️  Provider NÃO é Baileys (é:", conn?.provider || "NENHUM", ")");
    console.log("   Execute: npx tsx scripts/switch-to-baileys.ts");
  }
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());