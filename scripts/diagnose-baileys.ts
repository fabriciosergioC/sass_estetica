// Script de diagnóstico do Baileys.
// Execute: npx tsx scripts/diagnose-baileys.ts
// Mostra exatamente o que o Baileys faz ao inicializar uma sessão.
// NÃO modifica nada - apenas observa.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";

async function main() {
  const authDirs = readdirSync(".")
    .filter((d) => d.startsWith("baileys_auth_"))
    .map((d) => d.replace("baileys_auth_", ""));

  console.log("=".repeat(60));
  console.log("DIAGNÓSTICO BAILEYS");
  console.log("=".repeat(60));
  console.log(`Pasta de auth encontrada: ${authDirs.length === 0 ? "nenhuma" : authDirs.join(", ")}`);

  const orgId = authDirs[0] ?? "diagnostico";
  const authFolder = `./baileys_auth_${orgId}`;

  if (!existsSync(authFolder)) {
    console.log(`⚠️  Pasta ${authFolder} não existe. Criando...`);
  }

  if (existsSync(authFolder)) {
    console.log(`\n📂 Conteúdo de ${authFolder}:`);
    for (const f of readdirSync(authFolder)) {
      console.log(`   - ${f}`);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  console.log(`\n🔐 Credenciais carregadas:`);
  console.log(`   hasCreds: ${!!state.creds}`);
  console.log(`   registrationId: ${state.creds?.registrationId ?? "nenhum"}`);
  console.log(`   identityKeys: ${state.creds?.signedIdentityKey ? "presentes" : "ausentes"}`);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`\n📦 Versão Baileys: ${version.join(".")} (Latest: ${isLatest})`);

  let qrCount = 0;
  let openCount = 0;
  let closeCount = 0;

  // Logger criado ANTES do sock (sem auto-referência).
  const logger = {
    level: "info" as const,
    child: () => logger,
    trace: (...args: any[]) => console.log(`[trace]`, ...args),
    debug: (...args: any[]) => console.log(`[debug]`, ...args),
    info: (...args: any[]) => console.log(`[info]`, ...args.map(String)),
    warn: (...args: any[]) => console.log(`[warn]`, ...args),
    error: (...args: any[]) => console.log(`[ERROR]`, ...args),
  };

  console.log("\n🚀 Criando WASocket e registrando listeners...\n");

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: logger as any,
    browser: ["Diagnóstico", "Chrome", "1.0"],
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`\n📡 event connection.update:`);
    console.log(`   connection: ${connection ?? "(null)"}`);
    console.log(`   qr: ${qr ? `<presente, ${qr.length} chars>` : "ausente"}`);
    if (lastDisconnect) {
      console.log(`   lastDisconnect.error:`, lastDisconnect.error);
    }

    if (qr) {
      qrCount++;
      console.log(`\n✅ QR #${qrCount} recebido. Mostrando no terminal:\n`);
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`\n(O QR também fica disponível se você escanear.)`);
    }
    if (connection === "open") {
      openCount++;
      console.log(`\n✅✅ CONECTADO! (${openCount}ª vez)`);
    }
    if (connection === "close") {
      closeCount++;
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      console.log(`\n❌ Conexão fechada (${closeCount}ª vez). statusCode=${code}`);
      console.log(`   Motivo traduzido: ${code === DisconnectReason.loggedOut ? "LOGOUT" : code ?? "desconhecido"}`);
      if (closeCount > 2) {
        console.log("\n🛑 Encerrando diagnóstico.");
        process.exit(0);
      }
    }
  });

  sock.ev.on("creds.update", () => {
    console.log(`💾 creds.update disparado - salvando...`);
    saveCreds();
  });

  console.log("\n⏳ Aguardando eventos por até 30 segundos...");
  console.log("   Se um QR aparecer acima, escaneie com o WhatsApp.");
  console.log("   Se aparecer 'CONECTADO', a sessão está válida.");
  console.log("   Se não aparecer nada, há um problema de rede/Baileys.\n");

  setTimeout(() => {
    console.log("\n⏰ Timeout de 30s atingido.");
    console.log(`   Resumo: qr=${qrCount}, open=${openCount}, close=${closeCount}`);
    if (qrCount === 0 && openCount === 0) {
      console.log("\n🔴 DIAGNÓSTICO: Nenhum QR nem conexão aberta foi recebida em 30s.");
      console.log("   Possíveis causas:");
      console.log("   1. O Baileys não está conseguindo alcançar o WhatsApp (rede/firewall)");
      console.log("   2. A versão do Baileys está incompatível");
      console.log("   3. Sessão corrompida - tente apagar a pasta baileys_auth_*");
    }
    process.exit(0);
  }, 30_000);
}

main().catch((err) => {
  console.error("\n🛑 Erro fatal:", err);
  process.exit(1);
});
