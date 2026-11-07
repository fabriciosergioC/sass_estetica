import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";

export async function GET() {
  try {
    const { orgId, session } = await requireOrg();

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endToday = new Date(startToday.getTime() + 24 * 60 * 60 * 1000);
    const startPeriod30 = new Date(startToday.getTime() - 29 * 24 * 60 * 60 * 1000);

    const [org, customers, barbers, services, todayAppointments, openOpportunities, payments, statusGroups, topServices, topBarbers, newCustomers, upcoming, topOpportunities, returnDue, riskAppts] =
      await Promise.all([
        db.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, slug: true, status: true } }),
        db.customer.count({ where: { orgId } }),
        db.barber.count({ where: { orgId, active: true } }),
        db.service.count({ where: { orgId, active: true } }),
        db.appointment.count({
          where: { orgId, startAt: { gte: startToday, lt: endToday }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
        }),
        db.opportunity.count({ where: { orgId, status: "OPEN" } }),
        db.payment.findMany({
          where: { orgId, status: "PAID", paidAt: { gte: startPeriod30 } },
          select: { amountCents: true },
        }),
        db.appointment.groupBy({
          by: ["status"],
          where: { orgId, startAt: { gte: startPeriod30 } },
          _count: { _all: true },
        }),
        db.appointment.groupBy({
          by: ["serviceId"],
          where: { orgId, status: "COMPLETED", startAt: { gte: startPeriod30 } },
          _count: { _all: true },
          _sum: { priceCents: true },
          orderBy: { _count: { serviceId: "desc" } },
          take: 5,
        }),
        db.appointment.groupBy({
          by: ["barberId"],
          where: { orgId, status: "COMPLETED", startAt: { gte: startPeriod30 } },
          _count: { _all: true },
          _sum: { priceCents: true },
          orderBy: { _count: { barberId: "desc" } },
          take: 5,
        }),
        db.customer.count({ where: { orgId, createdAt: { gte: startPeriod30 } } }),
        db.appointment.findMany({
          where: { orgId, startAt: { gte: now, lt: endToday }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
          orderBy: { startAt: "asc" },
          take: 5,
          include: { customer: { select: { name: true } }, barber: { select: { name: true } } },
        }),
        db.opportunity.findMany({
          where: { orgId, status: "OPEN" },
          orderBy: [{ priority: "desc" }, { detectedAt: "desc" }],
          take: 3,
        }),
        db.customerMetrics.count({
          where: { customer: { orgId }, segment: { in: ["RETURN_DUE", "INACTIVE"] }, visits: { gte: 2 } },
        }),
        db.appointment.count({
          where: {
            orgId,
            startAt: { gte: now, lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) },
            status: { in: ["SCHEDULED", "CONFIRMED"] },
            customer: { metrics: { riskScore: { gte: 60 } } },
          },
        }),
      ]);

    const [serviceNames, barberNames] = await Promise.all([
      db.service.findMany({ where: { id: { in: topServices.map((s) => s.serviceId) } }, select: { id: true, name: true } }),
      db.barber.findMany({ where: { id: { in: topBarbers.map((b) => b.barberId) } }, select: { id: true, name: true } }),
    ]);

    const revenue = payments.reduce((acc, p) => acc + p.amountCents, 0);
    const statusCount = (s: string) => statusGroups.find((g) => g.status === s)?._count._all ?? 0;
    const completed = statusCount("COMPLETED");
    const noShows = statusCount("NO_SHOW");
    const cancelled = statusCount("CANCELLED");
    const ticket = payments.length > 0 ? Math.round(revenue / payments.length) : 0;
    const noShowRate = completed + noShows > 0 ? Math.round((noShows / (completed + noShows)) * 100) : 0;

    const checklist = [
      { done: services > 0, label: "Cadastrar serviços", href: "/app/servicos" },
      { done: barbers > 0, label: "Cadastrar atendentes", href: "/app/barbeiros" },
      { done: customers > 0, label: "Cadastrar clientes", href: "/app/clientes" },
    ];
    const pending = checklist.filter((c) => !c.done);

    return NextResponse.json({
      userName: session.name.split(" ")[0],
      org,
      kpis: {
        revenue,
        completed,
        ticket,
        newCustomers,
        todayAppointments,
        openOpportunities,
      },
      statusGroups: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
      noShowRate,
      cancelled,
      upcoming: upcoming.map((a) => ({
        id: a.id,
        startAt: a.startAt.toISOString(),
        customerName: a.customer.name,
        barberName: a.barber.name,
        status: a.status,
      })),
      topServices: topServices.map((s) => ({
        serviceId: s.serviceId,
        count: s._count._all,
        revenue: s._sum.priceCents ?? 0,
      })),
      topBarbers: topBarbers.map((b) => ({
        barberId: b.barberId,
        count: b._count._all,
        revenue: b._sum.priceCents ?? 0,
      })),
      serviceNames: serviceNames.map((s) => ({ id: s.id, name: s.name })),
      barberNames: barberNames.map((b) => ({ id: b.id, name: b.name })),
      topOpportunities,
      returnDue,
      riskAppts,
      pending,
      customers,
      barbers,
      services,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
