import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

async function test() {
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
      console.log("Conectado com sucesso!");
      console.log("\n--- Testando 5531987707962 ---");
      const res1 = await sock.onWhatsApp("5531987707962");
      console.log("onWhatsApp(5531987707962):", JSON.stringify(res1, null, 2));

      console.log("\n--- Testando 553187707962 ---");
      const res2 = await sock.onWhatsApp("553187707962");
      console.log("onWhatsApp(553187707962):", JSON.stringify(res2, null, 2));

      console.log("\n--- Testando com '+' ---");
      const res3 = await sock.onWhatsApp("+5531987707962");
      console.log("onWhatsApp(+5531987707962):", JSON.stringify(res3, null, 2));

      setTimeout(() => {
        sock.end(undefined);
        process.exit(0);
      }, 1000);
    }
  });
}

test().catch(console.error);
