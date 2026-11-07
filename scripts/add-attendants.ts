import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const ATTENDANTS = [
  { name: "Mariana Oliveira", specialties: "Esteticista" },
  { name: "Camila Rodrigues", specialties: "Especialista em Estética" },
  { name: "Juliana Martins", specialties: "Esteticista" },
  { name: "Beatriz Almeida", specialties: "Atendente" },
  { name: "Isabela Costa", specialties: "Esteticista" },
];

async function main() {
  const orgs = await db.organization.findMany({ select: { id: true, name: true } });
  if (orgs.length === 0) {
    console.log("Nenhuma organização encontrada no banco de dados.");
    return;
  }

  for (const org of orgs) {
    console.log(`Organização: ${org.name} (${org.id})`);
    for (const att of ATTENDANTS) {
      const existing = await db.barber.findFirst({
        where: { orgId: org.id, name: att.name },
      });
      if (existing) {
        console.log(`  - ${att.name} já cadastrado(a). Atualizando especialidade...`);
        await db.barber.update({
          where: { id: existing.id },
          data: { specialties: att.specialties, active: true },
        });
      } else {
        console.log(`  + Cadastrando ${att.name} (${att.specialties})...`);
        await db.barber.create({
          data: {
            orgId: org.id,
            name: att.name,
            specialties: att.specialties,
            commissionPct: 0,
            active: true,
          },
        });
      }
    }
  }
  console.log("Concluído com sucesso!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
