/* Teste da regra de duplicidade de telefone SEM depender do servidor nem do banco de
 * desenvolvimento: cria um SQLite descartável a partir do schema, grava clientes nos formatos
 * que os vários caminhos do CRM produzem de verdade, e confere se `findCustomerByPhone` barra
 * o repetido. O arquivo é apagado no fim.
 *
 * Uso (o servidor NÃO precisa estar rodando):
 *   DATABASE_URL="file:./dedupe-test.db" npx prisma db push --skip-generate
 *   DATABASE_URL="file:./dedupe-test.db" npx tsx scripts/test-phone-dedupe.ts
 */
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { phoneKey } from "../src/lib/phone";
import { findCustomerByPhone, phoneConflictMessage } from "../src/modules/crm/customers";

const db = new PrismaClient();
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const mobile = `9${Date.now().toString().slice(-8)}`; // ex.: 912345678
  const national = `31${mobile}`; // DDD + número (11 dígitos)
  const withDdi = `55${national}`; // 13 dígitos

  // Os três formatos que JÁ existem no banco, produzidos por caminhos diferentes.
  const formats = {
    cadastroManual: `+${national}`,
    agendamentoOnline: `+55 (31) ${mobile.slice(0, 4)}-${mobile.slice(4)}`,
    seed: `+${withDdi}`,
  };

  const org = await db.organization.create({
    data: { name: "Barbearia Teste Dedupe", slug: `dedupe-${Date.now()}`, status: "ACTIVE" },
  });
  const criado = await db.customer.create({
    data: { orgId: org.id, name: "Cliente Original", phone: formats.agendamentoOnline },
  });
  const outro = await db.customer.create({
    data: { orgId: org.id, name: "Outro Cliente", phone: `+${national.slice(0, 2)}999990000` },
  });

  console.log("\nphoneKey — formatos diferentes, mesma chave:");
  const keys = Object.entries(formats).map(([label, value]) => `${label}=${phoneKey(value)}`);
  check("as três grafias viram a mesma chave", new Set(keys.map((k) => k.split("=")[1])).size === 1, keys.join(" | "));

  console.log("\nfindCustomerByPhone — o que a rota chama antes de salvar:");
  for (const [label, value] of Object.entries(formats)) {
    const hit = await findCustomerByPhone(org.id, value);
    check(`bloqueia "${value}" (${label})`, hit?.id === criado.id, hit ? phoneConflictMessage(hit) : "nenhum conflito");
  }
  for (const digitado of [
    national,
    withDdi,
    `(31) ${mobile.slice(0, 4)}-${mobile.slice(4)}`,
    `55.31.${mobile.slice(0, 4)}${mobile.slice(4)}`,
    `  ${national} `,
  ]) {
    const hit = await findCustomerByPhone(org.id, digitado);
    check(`bloqueia digitado solto "${digitado}"`, hit?.id === criado.id);
  }

  const livre = await findCustomerByPhone(org.id, `+5531911112222`);
  check("deixa passar número que ainda não existe", livre === null);

  const mesmo = await findCustomerByPhone(org.id, formats.cadastroManual, { exceptId: criado.id });
  check("edição do próprio cliente não colide consigo mesma", mesmo === null);

  const vazio = await findCustomerByPhone(org.id, "");
  check("telefone vazio não casa com nada (não bloqueia a edição)", vazio === null);

  const deOutroOrg = await findCustomerByPhone(`org-inexistente`, formats.cadastroManual);
  check("a busca é limitada à barbearia (multi-tenant)", deOutroOrg === null);

  // Números de outros clientes não podem ser confundidos com este.
  const vizinho = await findCustomerByPhone(org.id, `+${national.slice(0, 2)}999990000`);
  check("conflito aponta para o dono certo", vizinho?.id === outro.id, vizinho?.name);

  await db.customer.deleteMany({ where: { orgId: org.id } });
  await db.organization.delete({ where: { id: org.id } });
}

/** No Windows o handle do SQLite pode sobreviver alguns instantes ao $disconnect. */
async function removeScratch(path: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!existsSync(path)) return true;
    try {
      unlinkSync(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return !existsSync(path);
}

main()
  .catch((err) => {
    failures += 1;
    console.error("✗ o teste quebrou:", err instanceof Error ? err.message : err);
  })
  .finally(async () => {
    await db.$disconnect();
    const removed = await removeScratch(join(process.cwd(), "prisma", "dedupe-test.db"));
    console.log(
      removed
        ? (failures === 0 ? "\nTudo certo (banco de teste apagado).\n" : `\n${failures} verificação(ões) falhou(ram).\n`)
        : "\n! o banco descartável de teste não foi apagado — dele prisma/dedupe-test.db (ele não é usado pelo app).\n"
    );
    process.exit(failures === 0 ? 0 : 1);
  });
