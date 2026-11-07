import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requireClienteOrg } from "@/lib/auth/client-guards";
import { formatBRL } from "@/lib/format";

/** GET /api/cliente-portal/[slug]/me — dados resumidos do cliente logado. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { session, orgId } = await requireClienteOrg();
    const { slug } = await params;

    const [org, customer] = await Promise.all([
      db.organization.findUnique({
        where: { slug },
        select: {
          status: true,
          name: true,
          slug: true,
          primaryColor: true,
          description: true,
          address: true,
          city: true,
          state: true,
          instagram: true,
          phone: true,
        },
      }),
      db.customer.findFirst({
        where: { id: session.customerId, orgId },
      }),
    ]);

    if (!org || org.status !== "ACTIVE") return jsonOk({ error: "Clínica indisponível." }, 404);
    if (!customer) {
      return jsonOk({ error: "Conta não encontrada. Entre novamente." }, 401);
    }

    // Próximo e anterior agendamento
    const appts = await db.appointment.findMany({
      where: { orgId, customerId: customer.id, status: { notIn: ["CANCELLED"] } },
      orderBy: { startAt: "desc" },
      take: 20,
      include: {
        barber: { select: { id: true, name: true } },
        service: { select: { id: true, name: true, durationMin: true } },
      },
    });

    const now = new Date();
    const upcoming = appts
      .filter((a) => ["SCHEDULED", "CONFIRMED", "IN_SERVICE"].includes(a.status) && a.startAt >= now)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const past = appts.filter((a) => a.startAt < now).sort((a, b) => b.startAt.getTime() - a.startAt.getTime());

    const completed = appts.filter((a) => a.status === "COMPLETED");
    const totalSpent = await db.payment.aggregate({
      where: { orgId, appointment: { customerId: customer.id, status: "COMPLETED" }, status: "PAID" },
      _sum: { amountCents: true },
    });

    return jsonOk({
      org,
      cliente: { id: customer.id, name: customer.name, phone: customer.phone },
      upcoming: upcoming.map((a) => ({
        id: a.id,
        startAt: a.startAt,
        status: a.status,
        serviceName: a.service.name,
        durationMin: a.service.durationMin,
        barberName: a.barber.name,
        priceCents: a.priceCents,
        notes: a.notes,
      })),
      historico: past.map((a) => ({
        id: a.id,
        startAt: a.startAt,
        status: a.status,
        serviceName: a.service.name,
        barberName: a.barber.name,
        priceCents: a.priceCents,
      })),
      resumo: {
        visitas: completed.length,
        totalGasto: formatBRL(totalSpent._sum.amountCents ?? 0),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
