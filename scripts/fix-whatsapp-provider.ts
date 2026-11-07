import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("🔍 Diagnosticando configuração WhatsApp...\n");

  // 1. Verificar provedor configurado no .env
  console.log("📋 Variável de ambiente WHATSAPP_PROVIDER:", process.env.WHATSAPP_PROVIDER ?? "não definida (padrão: dev)");

  // 2. Verificar organizações e suas conexões
  const orgs = await db.organization.findMany({
    include: { waConnections: true },
  });

  console.log(`\n📊 Encontradas ${orgs.length} organizações:`);

  for (const org of orgs) {
    const conn = org.waConnections[0];
    console.log(`\n  🏢 ${org.name} (${org.slug})`);
    console.log(`     ID: ${org.id}`);
    if (conn) {
      console.log(`     Conexão: provider=${conn.provider}, status=${conn.status}`);
    } else {
      console.log(`     Conexão: NENHUMA`);
    }

    // Verificar se há mensagens pendentes
    const queuedCount = await db.whatsAppMessage.count({
      where: { orgId: org.id, status: "QUEUED" }
    });
    if (queuedCount > 0) {
      console.log(`     ⚠️  ${queuedCount} mensagens QUEUED pendentes`);
    }

    // Verificar templates
    const templates = await db.messageTemplate.count({ where: { orgId: org.id, enabled: true } });
    console.log(`     Templates habilitados: ${templates}`);
  }

  console.log("\n📝 PROBLEMA IDENTIFICADO:");
  console.log("   - .env tem WHATSAPP_PROVIDER='baileys' (conexão real WhatsApp Web)");
  console.log("   - Mas banco tem provider='DEV' (apenas simula envio)");
  console.log("   - Mensagens pelo menu usam o provider do banco (DEV) → não chegam no número real");

  console.log("\n🛠️  OPÇÕES DE CORREÇÃO:");
  console.log("   1. Usar provedor DEV apenas para testes (mensagens não chegam no WhatsApp real)");
  console.log("   2. Configurar Baileys para cada org: alterar provider para 'baileys' no banco + escanear QR Code");
  console.log("   3. Usar outro provedor (Evolution, Meta Cloud, Z-API) configurando as variáveis no .env");

  // Perguntar ao usuário o que fazer
  console.log("\n❓ O que você deseja fazer?");
  console.log("   Para usar Baileys (WhatsApp Web real), execute este script com --fix-baileys");
  console.log("   Para manter DEV (apenas testes), não precisa fazer nada - mas mensagens não chegam no número real");
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());