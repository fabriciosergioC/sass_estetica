/**
 * Teste de envio de mensagem WhatsApp
 *
 * Este script testa o fluxo completo:
 * 1. Cria/usa organização de teste
 * 2. Configura conexão WhatsApp (provedor DEV)
 * 3. Envia mensagem de teste via API
 * 4. Processa job de envio
 * 5. Verifica status da mensagem
 *
 * Execute com: npx tsx scripts/test-whatsapp-send.ts
 */

import { PrismaClient } from "@prisma/client";
import { normalizePhone } from "@/lib/phone";
import { sendTemplateMessage } from "@/modules/whatsapp/messages";
import { enqueueJob, processJobs } from "@/modules/automation/jobs";
import { getWhatsAppProvider } from "@/modules/whatsapp/provider";

const db = new PrismaClient();

async function main() {
  console.log("🧪 Iniciando teste de envio WhatsApp...\n");

  // 1. Buscar ou criar organização de teste
  let org = await db.organization.findFirst({
    where: { slug: "test-whatsapp" },
  });

  if (!org) {
    console.log("📝 Criando organização de teste...");
    const user = await db.user.create({
      data: {
        name: "Test User",
        email: `test-${Date.now()}@example.com`,
        passwordHash: "hash",
      },
    });

    org = await db.organization.create({
      data: {
        name: "Test WhatsApp Org",
        slug: "test-whatsapp",
        status: "ACTIVE",
        city: "São Paulo",
        state: "SP",
        members: { create: { userId: user.id, role: "ADMIN", status: "ACTIVE" } },
        waConnections: { create: { provider: "DEV", status: "CONNECTED" } },
      },
    });
    console.log(`✅ Organização criada: ${org.id}`);
  } else {
    console.log(`✅ Organização encontrada: ${org.id}`);
  }

  // 2. Garantir conexão WhatsApp ativa (provedor DEV)
  let conn = await db.whatsAppConnection.findUnique({ where: { orgId: org.id } });
  if (!conn) {
    conn = await db.whatsAppConnection.create({
      data: { orgId: org.id, provider: "DEV", status: "CONNECTED" },
    });
    console.log("✅ Conexão WhatsApp criada (DEV)");
  } else if (conn.status !== "CONNECTED") {
    conn = await db.whatsAppConnection.update({
      where: { orgId: org.id },
      data: { status: "CONNECTED" },
    });
    console.log("✅ Conexão WhatsApp atualizada para CONNECTED");
  } else {
    console.log("✅ Conexão WhatsApp já CONNECTED");
  }

  // 3. Criar cliente de teste com opt-in
  let customer = await db.customer.findFirst({
    where: { orgId: org.id, phone: "+5511999999999" },
  });

  if (!customer) {
    customer = await db.customer.create({
      data: {
        orgId: org.id,
        name: "Cliente Teste",
        phone: "+5511999999999",
        whatsappOptIn: true,
      },
    });
    console.log("✅ Cliente de teste criado");
  } else {
    console.log("✅ Cliente de teste encontrado");
  }

  // 4. Garantir template de confirmação
  let template = await db.messageTemplate.findUnique({
    where: { orgId_key: { orgId: org.id, key: "confirmation" } },
  });

  if (!template) {
    template = await db.messageTemplate.create({
      data: {
        orgId: org.id,
        key: "confirmation",
        name: "Confirmação",
        body: "Olá {{cliente}}! Seu agendamento: {{servico}} com {{barbeiro}} em {{data}} às {{hora}} na {{barbearia}}.",
        enabled: true,
      },
    });
    console.log("✅ Template de confirmação criado");
  } else if (!template.enabled) {
    template = await db.messageTemplate.update({
      where: { orgId_key: { orgId: org.id, key: "confirmation" } },
      data: { enabled: true },
    });
    console.log("✅ Template de confirmação habilitado");
  } else {
    console.log("✅ Template de confirmação já existe e está habilitado");
  }

  // 5. Testar envio direto via sendTemplateMessage
  console.log("\n📤 Testando sendTemplateMessage...");
  const sent = await sendTemplateMessage({
    orgId: org.id,
    templateKey: "confirmation",
    vars: {
      customerId: customer.id,
      serviceName: "Corte + Barba",
      barberName: "João Silva",
      startAt: new Date("2026-10-27T14:30:00"),
    },
  });

  console.log(`Resultado sendTemplateMessage: ${sent ? "ENVIADO" : "NÃO ENVIADO (sem opt-in ou template desabilitado)"}`);

  // 6. Testar envio direto via API de teste (simula POST /api/whatsapp/test)
  console.log("\n📤 Testando envio via endpoint de teste (simulação)...");

  const testPhone = "+5511888888888";
  const normalizedPhone = normalizePhone(testPhone);

  if (!normalizedPhone) {
    console.log("❌ Telefone inválido");
    return;
  }

  const message = await db.whatsAppMessage.create({
    data: {
      orgId: org.id,
      direction: "OUT",
      phone: normalizedPhone,
      body: "Mensagem de teste manual via script",
      templateKey: null,
      status: "QUEUED",
    },
  });

  console.log(`✅ Mensagem criada na fila: ${message.id}`);

  // 7. Enfileirar job de envio
  await enqueueJob({
    type: "send_whatsapp",
    payload: { orgId: org.id, messageId: message.id },
  });
  console.log("✅ Job enfileirado");

  // 8. Processar jobs
  console.log("\n⚙️ Processando jobs...");
  const processed = await processJobs(10);
  console.log(`✅ Jobs processados: ${processed}`);

  // 9. Verificar status da mensagem
  const sentMessage = await db.whatsAppMessage.findUnique({
    where: { id: message.id },
  });

  console.log("\n📊 Resultado final:");
  console.log(`   ID: ${sentMessage?.id}`);
  console.log(`   Status: ${sentMessage?.status}`);
  console.log(`   ProviderMsgId: ${sentMessage?.providerMsgId ?? "N/A"}`);
  console.log(`   Error: ${sentMessage?.error ?? "N/A"}`);
  console.log(`   SentAt: ${sentMessage?.sentAt ?? "N/A"}`);

  // 10. Testar provedor diretamente
  console.log("\n🔌 Testando provedor DEV diretamente...");
  const provider = getWhatsAppProvider("dev");
  const result = await provider.sendMessage("+5511777777777", "Teste direto do provedor");
  console.log(`   Resultado: ${JSON.stringify(result)}`);

  // 11. Limpeza (opcional - comentar para inspecionar no Prisma Studio)
  // await db.whatsAppMessage.deleteMany({ where: { orgId: org.id } });
  // await db.whatsAppConnection.delete({ where: { orgId: org.id } });
  // await db.messageTemplate.deleteMany({ where: { orgId: org.id } });
  // await db.customer.deleteMany({ where: { orgId: org.id } });
  // await db.organizationMember.deleteMany({ where: { orgId: org.id } });
  // await db.organization.delete({ where: { id: org.id } });
  // await db.user.deleteMany({ where: { email: { startsWith: "test-" } } });

  console.log("\n✅ Teste concluído!");
}

main()
  .catch((e) => {
    console.error("❌ Erro no teste:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());