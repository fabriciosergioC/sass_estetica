// Métricas derivadas de cliente: recência, frequência, valor, segmento e risco.
// Recalculadas sob demanda (job compute_metrics) a partir do histórico real —
// nunca inventa dado: sem histórico suficiente, indicador fica null.
import { db } from "@/lib/db";

export type Segment = "NEW" | "RECURRENT" | "VIP" | "AT_RISK" | "INACTIVE" | "RETURN_DUE";

export type CustomerMetricsResult = {
  visits: number;
  noShows: number;
  cancellations: number;
  avgIntervalDays: number | null;
  lastVisitAt: Date | null;
  nextExpectedAt: Date | null;
  totalSpentCents: number;
  segment: Segment;
  riskScore: number;
  /** Explicabilidade: por que este segmento/risco. */
  reasons: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function computeCustomerMetrics(
  orgId: string,
  customerId: string
): Promise<CustomerMetricsResult | null> {
  const customer = await db.customer.findFirst({ where: { id: customerId, orgId } });
  if (!customer) return null;

  const [completed, noShowCount, cancelCount] = await Promise.all([
    db.appointment.findMany({
      where: { orgId, customerId, status: "COMPLETED" },
      orderBy: { startAt: "asc" },
      select: { startAt: true, priceCents: true },
    }),
    db.appointment.count({ where: { orgId, customerId, status: "NO_SHOW" } }),
    db.appointment.count({ where: { orgId, customerId, status: "CANCELLED" } }),
  ]);

  const visits = completed.length;
  const totalSpentCents = completed.reduce((sum, a) => sum + a.priceCents, 0);
  const lastVisitAt = visits > 0 ? completed[visits - 1].startAt : null;

  let avgIntervalDays: number | null = null;
  if (visits >= 2) {
    const spanDays =
      (completed[visits - 1].startAt.getTime() - completed[0].startAt.getTime()) / DAY_MS;
    avgIntervalDays = Math.round((spanDays / (visits - 1)) * 10) / 10;
  }
  const nextExpectedAt =
    avgIntervalDays && lastVisitAt
      ? new Date(lastVisitAt.getTime() + avgIntervalDays * DAY_MS)
      : null;

  const now = Date.now();
  const daysSinceLastVisit = lastVisitAt ? (now - lastVisitAt.getTime()) / DAY_MS : null;

  // Risco de falta (0-100): histórico objetivo de faltas/cancelamentos +
  // baixa frequência de confirmação implícita no histórico.
  const totalBookings = visits + noShowCount + cancelCount;
  const noShowRate = totalBookings > 0 ? noShowCount / totalBookings : 0;
  const cancelRate = totalBookings > 0 ? cancelCount / totalBookings : 0;
  const riskScore = Math.min(
    100,
    Math.round(noShowRate * 70 + cancelRate * 30 + Math.min(noShowCount, 3) * 5)
  );

  const reasons: string[] = [];
  if (totalBookings > 0) {
    reasons.push(
      `${visits} atendimentos, ${noShowCount} falta(s), ${cancelCount} cancelamento(s) em ${totalBookings} agendamentos`
    );
  }
  if (noShowCount > 0) reasons.push(`Taxa de falta de ${Math.round(noShowRate * 100)}%`);
  if (avgIntervalDays) reasons.push(`Intervalo médio entre cortes: ${avgIntervalDays} dias`);

  // Segmento
  let segment: Segment = "NEW";
  if (visits === 0) {
    segment = "NEW";
    reasons.push("Sem atendimentos concluídos");
  } else if (visits >= 10 && totalSpentCents >= 30000) {
    segment = "VIP";
    reasons.push("10+ atendimentos e ticket acumulado alto");
  } else if (visits >= 5) {
    segment = "RECURRENT";
    reasons.push("5+ atendimentos concluídos");
  }

  if (daysSinceLastVisit !== null && avgIntervalDays) {
    const overdue = daysSinceLastVisit - avgIntervalDays;
    if (overdue > avgIntervalDays * 0.8) {
      segment = "INACTIVE";
      reasons.push(
        `${Math.round(daysSinceLastVisit)} dias desde a última visita — ${Math.round(overdue)} dias acima do intervalo médio`
      );
    } else if (overdue > 0) {
      segment = "RETURN_DUE";
      reasons.push(
        `${Math.round(overdue)} dia(s) acima do intervalo médio (${Math.round(daysSinceLastVisit)} dias desde a última visita)`
      );
    }
  }
  if (riskScore >= 60 && segment !== "INACTIVE" && visits > 0) {
    segment = "AT_RISK";
    reasons.push(`Risco de falta elevado (${riskScore}/100)`);
  }

  await db.customerMetrics.upsert({
    where: { customerId },
    create: {
      customerId,
      visits,
      noShows: noShowCount,
      cancellations: cancelCount,
      avgIntervalDays,
      lastVisitAt,
      nextExpectedAt,
      totalSpentCents,
      segment,
      riskScore,
    },
    update: {
      visits,
      noShows: noShowCount,
      cancellations: cancelCount,
      avgIntervalDays,
      lastVisitAt,
      nextExpectedAt,
      totalSpentCents,
      segment,
      riskScore,
    },
  });

  return {
    visits,
    noShows: noShowCount,
    cancellations: cancelCount,
    avgIntervalDays,
    lastVisitAt,
    nextExpectedAt,
    totalSpentCents,
    segment,
    riskScore,
    reasons,
  };
}
