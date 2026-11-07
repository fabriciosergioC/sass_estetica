import { db } from "@/lib/db";
import {
  DAY_MS,
  addDays,
  bucketLabel,
  bucketStart,
  lastDayOf,
  nextBucket,
  startOfDay,
  toKey,
  type Granularity,
} from "@/lib/period";

/**
 * Faturamento por período (dia / semana / mês), em centavos.
 *
 * Por que fica aqui e não na rota: é a mesma conta que o Painel e a Agenda precisam enxergar
 * igual — dinheiro no caixa é uma coisa só no projeto. As datas e o recorte de período vêm de
 * `src/lib/period.ts`, que é puro e compartilhado com a tela.
 *
 * Convenções (as mesmas do `/api/dashboard`):
 *  - faturamento = `Payment.status = "PAID"`, somado por `paidAt`;
 *  - atendimento = `Appointment.status = "COMPLETED"`, somado por `startAt`;
 *  - valores em CENTAVOS (Int): quem formata R$ é a interface.
 */

export type RevenueBucket = {
  /** chave ordenável do período (YYYY-MM-DD do primeiro dia dele) */
  key: string;
  /** rótulo curto para o eixo do gráfico */
  label: string;
  /** rótulo longo para o título ("Novembro de 2026") */
  title: string;
  from: string; // YYYY-MM-DD
  to: string; //   YYYY-MM-DD (último dia DENTRO do período)
  faturamentoCents: number;
  atendimentos: number;
  ticketMedioCents: number;
};

export type RevenueReport = {
  granularity: Granularity;
  from: string;
  to: string;
  buckets: RevenueBucket[];
  total: { faturamentoCents: number; atendimentos: number; ticketMedioCents: number };
  /** Mesmo intervalo, imediatamente antes — é o comparativo que a tela mostra. */
  previous: {
    from: string;
    to: string;
    faturamentoCents: number;
    atendimentos: number;
    /** variação % do faturamento; `null` quando o período anterior não faturou (não há base) */
    variacaoPct: number | null;
  };
};

export async function getRevenueReport(opts: {
  orgId: string;
  granularity: Granularity;
  from: Date;
  to: Date;
}): Promise<RevenueReport> {
  const { orgId, granularity } = opts;
  const first = startOfDay(opts.from.getTime() <= opts.to.getTime() ? opts.from : opts.to);
  const lastInclusive = startOfDay(opts.to.getTime() >= opts.from.getTime() ? opts.to : opts.from);
  const last = addDays(lastInclusive, 1); // exclusive

  const spanDays = Math.round((last.getTime() - first.getTime()) / DAY_MS);
  const previousFrom = new Date(first.getTime() - spanDays * DAY_MS);

  const [payments, appointments, previousPayments, previousAppointments] = await Promise.all([
    db.payment.findMany({
      where: {
        orgId,
        status: "PAID",
        paidAt: { gte: first, lt: last },
        OR: [{ appointmentId: null }, { appointment: { status: { not: "CANCELLED" } } }],
      },
      select: { amountCents: true, paidAt: true },
    }),
    db.appointment.findMany({
      where: { orgId, status: "COMPLETED", startAt: { gte: first, lt: last } },
      select: { startAt: true },
    }),
    db.payment.findMany({
      where: {
        orgId,
        status: "PAID",
        paidAt: { gte: previousFrom, lt: first },
        OR: [{ appointmentId: null }, { appointment: { status: { not: "CANCELLED" } } }],
      },
      select: { amountCents: true },
    }),
    db.appointment.count({
      where: { orgId, status: "COMPLETED", startAt: { gte: previousFrom, lt: first } },
    }),
  ]);

  // Gera TODOS os baldes do intervalo, inclusive os vazios: é isso que faz o gráfico mensal
  // mostrar o mês que fechou em R$ 0 em vez de sumir com ele.
  const buckets = new Map<string, RevenueBucket>();
  for (let cursor = bucketStart(first, granularity); cursor < last; cursor = nextBucket(cursor, granularity)) {
    const key = toKey(cursor);
    buckets.set(key, {
      key,
      label: bucketLabel(cursor, granularity),
      title: bucketTitle(cursor, granularity),
      from: key,
      to: toKey(lastDayOf(cursor, granularity)),
      faturamentoCents: 0,
      atendimentos: 0,
      ticketMedioCents: 0,
    });
  }
  const bucketFor = (d: Date): RevenueBucket | undefined => buckets.get(toKey(bucketStart(d, granularity)));

  let totalFaturamento = 0;
  for (const p of payments) {
    if (!p.paidAt) continue;
    totalFaturamento += p.amountCents;
    const b = bucketFor(p.paidAt);
    if (b) b.faturamentoCents += p.amountCents;
  }
  let totalAtendimentos = 0;
  for (const a of appointments) {
    totalAtendimentos += 1;
    const b = bucketFor(a.startAt);
    if (b) b.atendimentos += 1;
  }
  for (const b of buckets.values()) {
    b.ticketMedioCents = b.atendimentos > 0 ? Math.round(b.faturamentoCents / b.atendimentos) : 0;
  }

  const previousTotal = previousPayments.reduce((sum, p) => sum + p.amountCents, 0);

  return {
    granularity,
    from: toKey(first),
    to: toKey(lastInclusive),
    buckets: [...buckets.values()],
    total: {
      faturamentoCents: totalFaturamento,
      atendimentos: totalAtendimentos,
      ticketMedioCents: totalAtendimentos > 0 ? Math.round(totalFaturamento / totalAtendimentos) : 0,
    },
    previous: {
      from: toKey(previousFrom),
      to: toKey(addDays(first, -1)),
      faturamentoCents: previousTotal,
      atendimentos: previousAppointments,
      variacaoPct:
        previousTotal > 0 ? Number((((totalFaturamento - previousTotal) / previousTotal) * 100).toFixed(1)) : null,
    },
  };
}

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Título do balde na lista de detalhamento. */
function bucketTitle(d: Date, granularity: Granularity): string {
  if (granularity === "day") return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (granularity === "week") {
    const end = lastDayOf(d, granularity);
    return `Semana de ${two(d.getDate())}/${two(d.getMonth() + 1)} a ${two(end.getDate())}/${two(end.getMonth() + 1)}`;
  }
  return `${MONTHS_PT[d.getMonth()]} de ${d.getFullYear()}`;
}
