import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

async function testSend() {
  const orgId = "cmuqps9by0001w6uovq91q77x";
  const { state } = await useMultiFileAuthState(`./baileys_auth_${orgId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: {
      level: "silent",
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => ({
        level: "silent",
        fatal: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
      }),
    } as any,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection } = update;
    if (connection === "open") {
      console.log("Socket conectado!");

      // Envia no JID correto de 8 dígitos retornado pelo onWhatsApp: 553187707962@s.whatsapp.net
      const targetJid = "553187707962@s.whatsapp.net";
      console.log(`Enviando mensagem de teste para ${targetJid}...`);

      const sent = await sock.sendMessage(targetJid, {
        text: "Teste de envio no formato correto (sem o 9º dígito extra). Por favor confirme se recebeu! 💈",
      });
      console.log("Resultado sendMessage:", JSON.stringify(sent?.key, null, 2));

      console.log("Aguardando 10s por recibos (delivery/read)...");
      setTimeout(() => {
        sock.end(undefined);
        process.exit(0);
      }, 10000);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      console.log("Recibo recebido para mensagem:", u.key?.id, "status:", u.update?.status);
    }
  });
}

testSend().catch(console.error);
