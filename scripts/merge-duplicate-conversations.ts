/**
 * Mescla contatos/conversas do WhatsApp que são a MESMA pessoa.
 *
 * Por que existe: o WhatsApp endereça a mesma conta por `55...@s.whatsapp.net` e por
 * `<id>@lid`. O código antigo casava contato só pelo JID cru, então a resposta de um cliente
 * que já tinha conversa pelo número abria contato #2 e conversa #2 na tela. A correção em
 * `src/modules/whatsapp/ingest.ts` impede novos casos; este script conserta o histórico que
 * já ficou dividido.
 *
 * Uso:
 *   npx tsx scripts/merge-duplicate-conversations.ts <orgId|slug>          # dry-run (padrão)
 *   npx tsx scripts/merge-duplicate-conversations.ts <orgId|slug> --apply  # escreve
 *
 * Regras:
 * - Duas linhas são a mesma pessoa quando compartilham telefone, @lid ou o jid uma da outra
 *   (laço de união, não igualdade de chave — o histórico tem linha @lid sem telefone).
 * - Canônica = a que tem telefone real; empate vai para customerId, depois para a mais antiga.
 * - Mensagens, follow-ups e etiquetas das duplicatas são MOVIDOS para a conversa canônica.
 * - Contato/conversa duplicados só são apagados depois de vazios (nada de mensagem órfã).
 * - Saída com telefone mascarado: interessa a quantidade de gente dividida, não o número.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const [target, flag] = process.argv.slice(2);
const APPLY = flag === "--apply";

type Member = {
  id: string;
  jid: string;
  lid: string | null;
  phone: string | null;
  name: string | null;
  customerId: string | null;
  createdAt: Date;
  conversationId: string | null;
  messages: number;
  labels: number;
};

/** `5531987707962` → `(31) 98770-****`: dá pra conferir sem expor o cliente no terminal. */
function maskPhone(phone: string | null): string {
  if (!phone) return "-";
  const d = phone.replace(/\D/g, "");
  if (d.length === 13) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 9)}-****`;
  if (d.length === 12) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 8)}-***`;
  return `${d.slice(0, Math.max(0, d.length - 4))}-****`;
}

/** Domínio + parte local do jid, sem o recurso `:12` que o WhatsApp acrescenta. */
function bare(jid: string): string {
  const [local, domain] = jid.split("@");
  return `${local.split(":")[0]}@${domain ?? ""}`;
}

/** Dígitos quando o jid é um número discável; `null` para @lid (identidade interna, não telefone). */
function digitsFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const d = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  return d.length >= 10 ? d : null;
}

/** Laço de união: cada chave de identidade (pn:/lid:/jid:) vira um nó; quem compartilha nó é parente. */
class Union {
  private parent = new Map<string, string>();
  find(x: string): string {
    const cur = this.parent.get(x);
    if (cur === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (cur === x) return x;
    const root = this.find(cur);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function identityKeys(c: Member): string[] {
  const keys: string[] = [`jid:${bare(c.jid)}`];
  if (c.lid) keys.push(`lid:${bare(c.lid)}`);
  // O jid @lid de uma linha pode ser exatamente o `lid` guardado em outra.
  if (c.jid.endsWith("@lid")) keys.push(`lid:${bare(c.jid)}`);
  const digits = c.phone ?? digitsFromJid(c.jid);
  if (digits) keys.push(`pn:${digits}`);
  return [...new Set(keys)];
}

function pickCanonical(group: Member[]): Member {
  const score = (m: Member) => (m.phone ? 4 : 0) + (m.customerId ? 2 : 0) + (m.messages > 0 ? 1 : 0);
  return [...group].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}

async function main() {
  if (!target) {
    throw new Error("informe a org: npx tsx scripts/merge-duplicate-conversations.ts <orgId|slug> [--apply]");
  }

  const org =
    (await db.organization.findUnique({ where: { id: target }, select: { id: true, name: true } })) ??
    (await db.organization.findUnique({ where: { slug: target }, select: { id: true, name: true } }));
  if (!org) throw new Error(`nenhuma org com id/slug "${target}"`);

  const contacts = await db.whatsAppContact.findMany({
    where: { orgId: org.id },
    select: {
      id: true, jid: true, lid: true, phone: true, name: true, customerId: true, createdAt: true,
      conversations: { select: { id: true, customerId: true, labels: { select: { labelId: true } } } },
      _count: { select: { messages: true } },
    },
  });

  const byId = new Map<string, Member>();
  for (const c of contacts) {
    byId.set(c.id, {
      id: c.id,
      jid: c.jid,
      lid: c.lid,
      phone: c.phone,
      name: c.name,
      customerId: c.customerId,
      createdAt: c.createdAt,
      conversationId: c.conversations[0]?.id ?? null,
      messages: c._count.messages,
      labels: c.conversations[0]?.labels.length ?? 0,
    });
  }

  const union = new Union();
  for (const c of byId.values()) {
    const keys = identityKeys(c);
    for (const k of keys.slice(1)) union.union(keys[0], k);
  }

  const groups = new Map<string, Member[]>();
  for (const c of byId.values()) {
    const root = union.find(identityKeys(c)[0]);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  }

  const merges = [...groups.values()].filter((g) => g.length > 1);
  const totalMessages = contacts.reduce((s, c) => s + c._count.messages, 0);
  console.log(
    `\n=== ${org.name} (${org.id}) — ${contacts.length} contato(s), ${totalMessages} mensagem(ns) ===\n` +
      `${merges.length} pessoa(s) com conversa dividida em mais de uma linha.`
  );

  if (merges.length === 0) {
    console.log("Nada a mesclar.");
    return;
  }

  let movedMessages = 0;
  let removedContacts = 0;

  for (const group of merges) {
    const canonical = pickCanonical(group);
    const dupes = group.filter((m) => m.id !== canonical.id);
    const dupeMessages = dupes.reduce((s, d) => s + d.messages, 0);
    movedMessages += dupeMessages;
    removedContacts += dupes.length;

    console.log(
      `\n> ${canonical.name ?? "(sem nome)"} — fica: [${bare(canonical.jid)}] tel=${maskPhone(canonical.phone)} msgs=${canonical.messages}`
    );
    for (const d of dupes) {
      console.log(
        `  duplicada: ${d.name ?? "(sem nome)"} [${bare(d.jid)}] tel=${maskPhone(d.phone)} ` +
          `lid=${d.lid ? "sim" : "não"} msgs=${d.messages} labels=${d.labels}`
      );
    }

    if (!APPLY) continue;

    await db.$transaction(async (tx) => {
      // Se a canônica não tem conversa mas uma duplicata tem, aproveitamos a dela em vez de
      // destruir e recriar: mantém histórico de status/etiquetas e evita ficar sem thread.
      if (!canonical.conversationId) {
        const carrier = dupes.find((d) => d.conversationId);
        if (carrier?.conversationId) {
          await tx.whatsAppConversation.update({
            where: { id: carrier.conversationId },
            data: { contactId: canonical.id },
          });
          canonical.conversationId = carrier.conversationId;
          carrier.conversationId = null;
        }
      }

      for (const d of dupes) {
        if (d.conversationId && canonical.conversationId) {
          // Etiquetas e follow-ups sobrevivem à mesclagem: vão junto para a conversa boa.
          // `skipDuplicates` do createMany não é suportado no SQLite (o Prisma marca o campo
          // como `never`), então filtramos em memória antes de inserir.
          if (d.labels > 0) {
            const labels = await tx.whatsAppConversationLabel.findMany({
              where: { conversationId: d.conversationId },
              select: { labelId: true },
            });
            const already = new Set(
              (
                await tx.whatsAppConversationLabel.findMany({
                  where: { conversationId: canonical.conversationId },
                  select: { labelId: true },
                })
              ).map((l) => l.labelId)
            );
            for (const l of labels) {
              if (already.has(l.labelId)) continue;
              await tx.whatsAppConversationLabel.create({
                data: { conversationId: canonical.conversationId, labelId: l.labelId },
              });
              already.add(l.labelId);
            }
          }
          await tx.whatsAppFollowUp.updateMany({
            where: { conversationId: d.conversationId },
            data: { conversationId: canonical.conversationId },
          });
          await tx.whatsAppMessage.updateMany({
            where: { conversationId: d.conversationId },
            data: { conversationId: canonical.conversationId, contactId: canonical.id },
          });
          // Cliente de CRM conhecido na duplicata não pode se perder na hora de apagar.
          const canonicalConv = await tx.whatsAppConversation.findUnique({
            where: { id: canonical.conversationId },
            select: { customerId: true },
          });
          const dupeConv = await tx.whatsAppConversation.findUnique({
            where: { id: d.conversationId },
            select: { customerId: true },
          });
          if (!canonicalConv?.customerId && dupeConv?.customerId) {
            await tx.whatsAppConversation.update({
              where: { id: canonical.conversationId },
              data: { customerId: dupeConv.customerId },
            });
          }
          await tx.whatsAppConversation.delete({ where: { id: d.conversationId } });
        }

        await tx.whatsAppMessage.updateMany({ where: { contactId: d.id }, data: { contactId: canonical.id } });

        // O lid da duplicata é informação útil: passa para a canônica se ela não tinha.
        const lidToCarry = d.lid ?? (d.jid.endsWith("@lid") ? d.jid : null);
        if (lidToCarry) {
          const still = await tx.whatsAppContact.findUnique({ where: { id: canonical.id }, select: { lid: true } });
          if (!still?.lid) {
            await tx.whatsAppContact.update({ where: { id: canonical.id }, data: { lid: lidToCarry } });
          }
        }
        // Telefone descoberto pela duplicata (a canônica pode ter chegado antes só pelo @lid).
        if (!canonical.phone && d.phone) {
          await tx.whatsAppContact.update({
            where: { id: canonical.id },
            data: { phone: d.phone, masked: false },
          });
          canonical.phone = d.phone;
        }
        if (!canonical.customerId && d.customerId) {
          await tx.whatsAppContact.update({ where: { id: canonical.id }, data: { customerId: d.customerId } });
          canonical.customerId = d.customerId;
        }
        await tx.whatsAppContact.delete({ where: { id: d.id } });
      }

      // Recalcula o preview da conversa canônica com a mensagem mais recente que restou.
      if (canonical.conversationId) {
        const last = await tx.whatsAppMessage.findFirst({
          where: { conversationId: canonical.conversationId },
          orderBy: { createdAt: "desc" },
          select: { body: true, createdAt: true, messageType: true },
        });
        if (last) {
          await tx.whatsAppConversation.update({
            where: { id: canonical.conversationId },
            data: {
              lastBody: `${last.messageType === "text" ? "" : `[${last.messageType}] `}${last.body}`.slice(0, 280),
              lastMessageAt: last.createdAt,
            },
          });
        }
      }
    });
  }

  console.log(
    `\n${APPLY ? "Mesclado" : "Dry-run (nada foi escrito)"}: ${removedContacts} contato(s) duplicado(s) removidos, ` +
      `${movedMessages} mensagem(ns) relocalizadas.`
  );
  if (!APPLY) console.log("Rode de novo com --apply para escrever. Antes disso, faça backup de prisma/dev.db.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
