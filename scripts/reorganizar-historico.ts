/* Reorganiza o histórico do WhatsApp (a ação do botão "🧹 Reorganizar histórico", §12).
 *
 * Faz exatamente o que a tela faz — loga de verdade e chama POST /api/whatsapp/admin/backfill —
 * para que o caminho testado seja o mesmo caminho usado pelo barbeiro, com o mesmo provedor,
 * o mesmo .env e a mesma sessão do servidor. Rodar por script só economiza o clique.
 *
 * É idempotente e não envia nada: cria contato/conversa a partir do número já gravado e
 * aponta cada mensagem órfã para ela. Pode rodar duas vezes; a segunda não muda nada.
 *
 * Uso:
 *   1. suba o servidor: npm run dev
 *   2. rode: npx tsx scripts/reorganizar-historico.ts
 *
 * Variáveis opcionais: BASE_URL, SEED_EMAIL, SEED_PASSWORD
 * ANTES de rodar, faça cópia de prisma/dev.db (o script só lê e aponta, mas histórico é histórico).
 */

import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.SEED_EMAIL ?? "rafael@navalhadeouro.com";
const PASSWORD = process.env.SEED_PASSWORD ?? "senha1234";

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login falhou (${res.status}) para ${EMAIL}. Rode npm run db:seed?`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Resposta de login sem cookie de sessão.");
  return cookie;
}

async function main() {
  const db = new PrismaClient();
  const countOrphans = () => db.whatsAppMessage.count({ where: { conversationId: null } });
  const countConvs = () => db.whatsAppConversation.count();

  console.log(`\n${BASE} · ${EMAIL}`);
  console.log(`antes: ${await countOrphans()} mensagem(ns) sem conversa · ${await countConvs()} conversa(s)`);

  const cookie = await login();
  const res = await fetch(`${BASE}/api/whatsapp/admin/backfill`, { method: "POST", headers: { cookie } });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`✗ o servidor recusou (${res.status}):`, data.error ?? JSON.stringify(data));
    await db.$disconnect();
    process.exitCode = 1;
    return;
  }

  const ignoradas = Array.isArray(data.skipped) ? ` · ignoradas ${data.skipped.length}` : "";
  console.log(`resultado: ligadas ${data.linked ?? 0} de ${data.scanned ?? 0} mensagem(ns)${ignoradas}`);
  console.log(`depois: ${await countOrphans()} mensagem(ns) sem conversa · ${await countConvs()} conversa(s)`);
  console.log("\nDica: abra /app/whatsapp e confira se as conversas antigas apareceram na lista.");

  await db.$disconnect();
}

main().catch((err) => {
  console.error("Falhou:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
