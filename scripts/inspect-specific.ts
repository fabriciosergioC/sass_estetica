import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const contacts = await db.whatsAppContact.findMany({
    where: { orgId: "cmuqps9by0001w6uovq91q77x" },
  });
  console.log(
    "Contacts in Barbearia Imperial:",
    contacts.map((c) => ({ id: c.id, jid: c.jid, phone: c.phone, name: c.name }))
  );

  const convs = await db.whatsAppConversation.findMany({
    where: { orgId: "cmuqps9by0001w6uovq91q77x" },
    include: { contact: true },
  });
  console.log(
    "Conversations in Barbearia Imperial:",
    convs.map((c) => ({
      id: c.id,
      contactJid: c.contact.jid,
      contactPhone: c.contact.phone,
      lastBody: c.lastBody,
    }))
  );
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
