import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function checkAllContacts() {
  const contacts = await db.whatsAppContact.findMany();
  console.log("Total contacts in DB:", contacts.length);
  for (const c of contacts) {
    console.log(`- Org: ${c.orgId} | ID: ${c.id} | JID: ${c.jid} | Phone: ${c.phone} | Name: ${c.name}`);
  }
}

checkAllContacts()
  .catch(console.error)
  .finally(() => db.$disconnect());
