/* Seed de desenvolvimento: 3 barbearias, 10 barbeiros, 100 clientes,
   serviços, agendamentos (histórico + futuros), faltas, cancelamentos, métricas. */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/* Guarda contra o seed de demonstração cair num banco de verdade.
   Ele cria 3 barbearias fictícias, 10 barbeiros e ~100 clientes. Em SQLite local isso é inofensivo;
   no Supabase seria lixo no banco onde seus clientes reais vão morar. Além de `prisma migrate dev`
   rodar o seed sozinho, é melhor recusar do que confiar na memória de quem digitou o comando. */
const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error(
    "DATABASE_URL não está no ambiente. Rode com o .env carregado:\n  npx tsx --env-file=.env prisma/seed.ts"
  );
  process.exit(1);
}
if (!url.startsWith("file:") && process.env.SEED_ALLOW_REMOTE !== "1") {
  console.error(
    "seed de demonstração bloqueado: o DATABASE_URL aponta para um banco remoto (Postgres/Supabase).\n" +
      "Ele insere 3 barbearias fictícias e ~100 clientes — não rode contra o banco com dados reais.\n" +
      "Se você tem certeza de que quer isso: SEED_ALLOW_REMOTE=1 npm run db:seed"
  );
  process.exit(1);
}

const db = new PrismaClient();

let rngState = 42;
function rnd(): number {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
function randInt(min: number, max: number): number {
  return Math.floor(min + rnd() * (max - min + 1));
}

const PLANS = [
  { code: "FREE", name: "Free", priceCents: 0, maxBarbers: 1, maxCustomers: 100, maxMessagesMonth: 100, sortOrder: 1, features: { automations: false, ai: false, reports: false, customPage: true, api: false } },
  { code: "BASIC", name: "Basic", priceCents: 4900, maxBarbers: 3, maxCustomers: 1000, maxMessagesMonth: 1000, sortOrder: 2, features: { automations: true, ai: false, reports: true, customPage: true, api: false } },
  { code: "PRO", name: "Pro", priceCents: 9900, maxBarbers: 10, maxCustomers: 5000, maxMessagesMonth: 10000, sortOrder: 3, features: { automations: true, ai: true, reports: true, customPage: true, api: true } },
  { code: "PREMIUM", name: "Premium", priceCents: 19900, maxBarbers: 50, maxCustomers: 50000, maxMessagesMonth: 100000, sortOrder: 4, features: { automations: true, ai: true, reports: true, customPage: true, api: true } },
];

const ORGS = [
  { name: "Barbearia Navalha de Ouro", slug: "navalha-de-ouro", admin: { name: "Rafael Souza", email: "rafael@navalhadeouro.com" } },
  { name: "Studio Barber Club", slug: "studio-barber-club", admin: { name: "Camila Torres", email: "camila@studiobarberclub.com" } },
  { name: "Dom Barber House", slug: "dom-barber-house", admin: { name: "Eduardo Lima", email: "eduardo@dombarberhouse.com" } },
];

const BARBER_NAMES = [
  "Lucas Mendes", "Diego Ferreira", "Bruno Almeida", "Thiago Ramos", "André Costa",
  "Marcelo Pinto", "Felipe Duarte", "Gustavo Rocha", "Rodrigo Nunes", "Vinícius Prado",
];

const FIRST = ["João", "Pedro", "Carlos", "Marcos", "Antônio", "Ronaldo", "Fábio", "Leandro", "Rogério", "Sérgio", "Wesley", "Juninho", "Adriano", "Cláudio", "Renato", "Márcio", "Alexandre", "Fernando", "Paulo", "Vitor"];
const LAST = ["Silva", "Santos", "Oliveira", "Pereira", "Lima", "Carvalho", "Ribeiro", "Martins", "Barbosa", "Nogueira", "Moraes", "Teixeira", "Cardoso", "Correia", "Azevedo"];

const SERVICES = [
  { name: "Corte Masculino", durationMin: 30, priceCents: 4500, category: "CABELO" },
  { name: "Corte + Barba", durationMin: 60, priceCents: 7000, category: "COMBO" },
  { name: "Barba Terapia", durationMin: 30, priceCents: 4000, category: "BARBA" },
  { name: "Corte Infantil", durationMin: 30, priceCents: 4000, category: "CABELO" },
  { name: "Pezinho", durationMin: 15, priceCents: 2000, category: "CABELO" },
  { name: "Platinado", durationMin: 120, priceCents: 15000, category: "QUÍMICA" },
  { name: "Relaxamento Capilar", durationMin: 60, priceCents: 9000, category: "QUÍMICA" },
];

async function main() {
  console.log("🧹 Limpando banco...");
  await db.$transaction([
    db.auditLog.deleteMany(),
    db.opportunityAction.deleteMany(),
    db.opportunity.deleteMany(),
    db.notification.deleteMany(),
    db.automationExecution.deleteMany(),
    db.automationRule.deleteMany(),
    db.webhookEvent.deleteMany(),
    db.job.deleteMany(),
    db.whatsAppMessage.deleteMany(),
    db.whatsAppConnection.deleteMany(),
    db.messageTemplate.deleteMany(),
    db.payment.deleteMany(),
    db.appointmentStatusHistory.deleteMany(),
    db.appointment.deleteMany(),
    db.customerMetrics.deleteMany(),
    db.customerNote.deleteMany(),
    db.barberService.deleteMany(),
    db.businessHour.deleteMany(),
    db.barberAvailability.deleteMany(),
    db.barberTimeOff.deleteMany(),
    db.service.deleteMany(),
    db.barber.deleteMany(),
    db.customer.deleteMany(),
    db.subscription.deleteMany(),
    db.organizationMember.deleteMany(),
    db.organization.deleteMany(),
    db.user.deleteMany(),
    db.plan.deleteMany(),
  ]);

  console.log("💳 Planos...");
  const plans: Record<string, string> = {};
  for (const p of PLANS) {
    const plan = await db.plan.create({ data: { ...p, features: JSON.stringify(p.features) } });
    plans[p.code] = plan.id;
  }

  const passwordHash = await bcrypt.hash("senha1234", 12);
  let barberIdx = 0;
  let phoneSeq = 910000000;
  const nextPhone = () => `+5511${phoneSeq++}`;

  for (const [orgIdx, cfg] of ORGS.entries()) {
    console.log(`💈 ${cfg.name}...`);
    const user = await db.user.create({
      data: { name: cfg.admin.name, email: cfg.admin.email, passwordHash, phone: nextPhone() },
    });

    const org = await db.organization.create({
      data: {
        name: cfg.name,
        slug: cfg.slug,
        status: "ACTIVE",
        phone: nextPhone(),
        description: "Barbearia com atendimento premium. Estacionamento no local.",
        city: "São Paulo",
        state: "SP",
        instagram: "@" + cfg.slug.replace(/-/g, ""),
        members: { create: { userId: user.id, role: "ADMIN", status: "ACTIVE" } },
        waConnections: { create: { provider: "DEV", status: "DISCONNECTED" } },
        subscription: { create: { planId: plans[orgIdx === 0 ? "PRO" : orgIdx === 1 ? "BASIC" : "FREE"], status: "ACTIVE" } },
      },
    });

    const templates = [
      { key: "confirmation", name: "Confirmação", body: "Olá, {{cliente}}! Seu horário está confirmado: {{servico}} com {{barbeiro}} em {{data}} às {{hora}} na {{barbearia}}. Até logo! ✂️" },
      { key: "reminder_24h", name: "Lembrete 24h", body: "Olá, {{cliente}}! Lembrete: seu horário na {{barbearia}} é amanhã, {{data}} às {{hora}}, com {{barbeiro}}. Confirma presença?" },
      { key: "cancellation", name: "Cancelamento", body: "Olá, {{cliente}}! Seu horário de {{data}} às {{hora}} na {{barbearia}} foi cancelado." },
      { key: "reschedule", name: "Remarcação", body: "Olá, {{cliente}}! Seu horário na {{barbearia}} foi remarcado para {{data}} às {{hora}} com {{barbeiro}}." },
      { key: "post_visit", name: "Pós-atendimento", body: "Olá, {{cliente}}! Obrigado pela visita na {{barbearia}}! Esperamos você novamente. Se puder, deixe sua avaliação. 💈" },
      { key: "return_due", name: "Retorno", body: "Olá, {{cliente}}! Já faz um tempinho desde seu último corte na {{barbearia}}. Vamos agendar? ✂️" },
      { key: "slot_recovery", name: "Recuperação de horário", body: "Olá, {{cliente}}! Surgiu um horário hoje às {{hora}} na {{barbearia}} com {{barbeiro}}. Gostaria de aproveitar?" },
    ];
    await db.messageTemplate.createMany({ data: templates.map((t) => ({ ...t, orgId: org.id })) });

    await db.automationRule.createMany({
      data: [
        { event: "appointment.cancelled", action: "send_whatsapp", config: { template: "cancellation" } },
        { event: "appointment.rescheduled", action: "send_whatsapp", config: { template: "reschedule" } },
        { event: "appointment.confirmed", action: "schedule_reminder", config: { template: "reminder_24h", hoursBefore: 24 } },
        { event: "appointment.completed", action: "schedule_reminder", config: { template: "post_visit", delayMinutes: 30 } },
        { event: "appointment.no_show", action: "notify_admin", config: { title: "Falta registrada" } },
        { event: "slot.opened", action: "create_opportunity", config: {} },
      ].map((r) => ({ ...r, orgId: org.id, config: JSON.stringify(r.config) })),
    });

    const orgBarbers = Math.min(4, 10 - barberIdx);
    const barbers = [];
    for (let i = 0; i < orgBarbers; i++) {
      const b = await db.barber.create({
        data: {
          orgId: org.id,
          name: BARBER_NAMES[barberIdx % BARBER_NAMES.length],
          specialties: pick(["Cortes clássicos", "Barba desenhada", "Degradê", "Platinado", "Navalhado"]),
          commissionPct: randInt(30, 50),
          active: true,
        },
      });
      barberIdx++;
      barbers.push(b);
      await db.businessHour.createMany({
        data: [1, 2, 3, 4, 5, 6].map((weekday) => ({
          orgId: org.id,
          barberId: b.id,
          weekday,
          openTime: weekday === 6 ? "09:00" : "09:00",
          closeTime: weekday === 6 ? "16:00" : "19:00",
          closed: false,
        })),
      });
      await db.businessHour.create({
        data: { orgId: org.id, barberId: b.id, weekday: 0, openTime: "09:00", closeTime: "13:00", closed: true },
      });
    }

    const services = [];
    for (const s of SERVICES) {
      services.push(await db.service.create({ data: { ...s, orgId: org.id, active: true } }));
    }
    for (const b of barbers) {
      const subset = services.filter(() => rnd() > 0.25);
      const chosen = subset.length > 0 ? subset : [services[0]];
      await db.barberService.createMany({
        data: chosen.map((s) => ({ barberId: b.id, serviceId: s.id })),
      });
    }

    // Clientes
    const customers = [];
    for (let i = 0; i < 34; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      customers.push(
        await db.customer.create({
          data: {
            orgId: org.id,
            name,
            phone: nextPhone(),
            birthday: new Date(randInt(1975, 2006), randInt(0, 11), randInt(1, 28)),
            whatsappOptIn: rnd() > 0.1,
          },
        })
      );
    }

    // Agendamentos: histórico de 90 dias + próximos 7 dias
    const now = new Date();
    let created = 0;
    for (let dayOffset = -90; dayOffset <= 7; dayOffset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      const weekday = day.getDay();
      if (weekday === 0) continue; // domingo fechado
      if (rnd() < 0.25) continue; // dia mais vazio

      const count = dayOffset <= 0 ? randInt(3, 9) : randInt(1, 5);
      for (let i = 0; i < count; i++) {
        const barber = pick(barbers);
        const service = pick(services);
        const customer = pick(customers);
        const hour = randInt(9, 18);
        const minute = pick([0, 30]);
        const startAt = new Date(day);
        startAt.setHours(hour, minute, 0, 0);
        const endAt = new Date(startAt.getTime() + service.durationMin * 60000);

        let status: string;
        if (dayOffset < 0) {
          const r = rnd();
          status = r < 0.78 ? "COMPLETED" : r < 0.88 ? "CANCELLED" : r < 0.96 ? "NO_SHOW" : "COMPLETED";
        } else if (dayOffset === 0) {
          status = startAt < now ? (rnd() < 0.85 ? "COMPLETED" : "NO_SHOW") : pick(["SCHEDULED", "CONFIRMED", "CONFIRMED"]);
        } else {
          status = pick(["SCHEDULED", "SCHEDULED", "CONFIRMED"]);
        }

        if (status === "COMPLETED" && endAt > now) continue;

        const appt = await db.appointment.create({
          data: {
            orgId: org.id,
            barberId: barber.id,
            customerId: customer.id,
            serviceId: service.id,
            startAt,
            endAt,
            status,
            priceCents: service.priceCents,
            source: pick(["ADMIN", "ADMIN", "PUBLIC"]),
          },
        });
        if (status === "COMPLETED") {
          await db.payment.create({
            data: {
              orgId: org.id,
              appointmentId: appt.id,
              amountCents: service.priceCents,
              status: "PAID",
              paidAt: endAt,
            },
          });
        }
        created++;
      }
    }

    // Métricas dos clientes a partir do histórico
    console.log(`   ${created} agendamentos; calculando métricas...`);
    for (const customer of customers) {
      const completed = await db.appointment.findMany({
        where: { orgId: org.id, customerId: customer.id, status: "COMPLETED" },
        orderBy: { startAt: "asc" },
      });
      const noShows = await db.appointment.count({ where: { orgId: org.id, customerId: customer.id, status: "NO_SHOW" } });
      const cancellations = await db.appointment.count({ where: { orgId: org.id, customerId: customer.id, status: "CANCELLED" } });

      const lastVisitAt = completed.at(-1)?.startAt ?? null;
      const totalSpentCents = completed.reduce((sum, a) => sum + a.priceCents, 0);
      let avgIntervalDays: number | null = null;
      if (completed.length >= 2) {
        const spanDays =
          (completed[completed.length - 1].startAt.getTime() - completed[0].startAt.getTime()) /
          (1000 * 60 * 60 * 24);
        avgIntervalDays = Math.round((spanDays / (completed.length - 1)) * 10) / 10;
      }
      const nextExpectedAt =
        avgIntervalDays && lastVisitAt
          ? new Date(lastVisitAt.getTime() + avgIntervalDays * 24 * 60 * 60 * 1000)
          : null;

      let segment = "NEW";
      if (completed.length >= 5) segment = "RECURRENT";
      if (completed.length >= 10) segment = "VIP";
      if (lastVisitAt) {
        const daysSince = (now.getTime() - lastVisitAt.getTime()) / (1000 * 60 * 60 * 24);
        if (avgIntervalDays && daysSince > avgIntervalDays * 1.8) segment = "INACTIVE";
        else if (avgIntervalDays && daysSince > avgIntervalDays) segment = "RETURN_DUE";
      }

      await db.customerMetrics.create({
        data: {
          customerId: customer.id,
          visits: completed.length,
          noShows,
          cancellations,
          avgIntervalDays,
          lastVisitAt,
          nextExpectedAt,
          totalSpentCents,
          segment,
          riskScore: noShows > 0 ? Math.min(100, (noShows * 30 + cancellations * 10) as number) : 0,
        },
      });
    }
  }

  console.log("✅ Seed concluído. Login: rafael@navalhadeouro.com / senha1234");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
