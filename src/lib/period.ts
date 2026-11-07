/**
 * Recortes de período (dia / semana / mês) compartilhados entre a API de relatórios e a tela.
 *
 * Fica em `src/lib` porque é puro: a tela de Relatórios é client component e não pode
 * importar nada que puxe o Prisma. Todo cálculo é em data LOCAL, igual à Agenda — o barbeiro
 * pensa no relógio da loja, não no UTC do banco.
 */

export type Granularity = "day" | "week" | "month";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Limita o recorte: um relatório de 10 anos de eixo não é o que a tela precisa. */
export const MAX_RANGE_DAYS = 400;

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Segunda-feira da semana daquele dia — a semana de trabalho da barbearia. */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = day.getDay() === 0 ? -6 : 1 - day.getDay();
  return addDays(day, offset);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function bucketStart(d: Date, granularity: Granularity): Date {
  if (granularity === "day") return startOfDay(d);
  if (granularity === "week") return startOfWeek(d);
  return startOfMonth(d);
}

export function nextBucket(d: Date, granularity: Granularity): Date {
  if (granularity === "day") return addDays(d, 1);
  if (granularity === "week") return addDays(d, 7);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/** Último dia DENTRO do período que começa em `d`. */
export function lastDayOf(d: Date, granularity: Granularity): Date {
  return addDays(nextBucket(d, granularity), -1);
}

/** `Date` → `YYYY-MM-DD` sem passar por UTC (o que vale é o dia da loja). */
export function toKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function shortDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Rótulo curto do eixo do gráfico: `12/11`, `Sem 09/11–15/11`, `nov/26`. */
export function bucketLabel(d: Date, granularity: Granularity): string {
  if (granularity === "day") return shortDate(d);
  if (granularity === "week") return `Sem ${shortDate(d)}–${shortDate(lastDayOf(d, granularity))}`;
  return `${MONTHS_SHORT[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`;
}

/** Rótulo longo para os títulos: `Novembro de 2026`, `Semana de 09/11 a 15/11`. */
export function rangeLabel(from: Date, to: Date, granularity: Granularity): string {
  if (granularity === "month" && from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear()) {
    return `${MONTHS_PT[from.getMonth()]} de ${from.getFullYear()}`;
  }
  if (granularity === "day" && from.getTime() === to.getTime()) {
    return `${String(from.getDate()).padStart(2, "0")} de ${MONTHS_PT[from.getMonth()]} de ${from.getFullYear()}`;
  }
  return `${shortDate(from)} a ${shortDate(to)}/${String(to.getFullYear()).slice(2)}`;
}

/**
 * Aceita `YYYY-MM-DD` (e ISO, pegando só a parte da data). `null` em string vazia/inválida —
 * quem chama devolve erro de requisição, não 500.
 */
export function parseLocalDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export type PeriodPreset = {
  id: string;
  label: string;
  /** Intervalo fechado [from, to] visto de `now`. */
  range: (now: Date) => { from: Date; to: Date };
};

/**
 * Os atalhos do filtro. Cada granularidade tem os seus porque "últimos 6 meses" não faz
 * sentido num relatório diário — e é daqui que sai o comparativo mês a mês que fecha.
 */
export const PERIOD_PRESETS: Record<Granularity, PeriodPreset[]> = {
  day: [
    { id: "today", label: "Hoje", range: (n) => ({ from: startOfDay(n), to: startOfDay(n) }) },
    { id: "yesterday", label: "Ontem", range: (n) => ({ from: addDays(startOfDay(n), -1), to: addDays(startOfDay(n), -1) }) },
    { id: "last7", label: "Últimos 7 dias", range: (n) => ({ from: addDays(startOfDay(n), -6), to: startOfDay(n) }) },
    { id: "last30", label: "Últimos 30 dias", range: (n) => ({ from: addDays(startOfDay(n), -29), to: startOfDay(n) }) },
  ],
  week: [
    { id: "this", label: "Esta semana", range: (n) => ({ from: startOfWeek(n), to: lastDayOf(startOfWeek(n), "week") }) },
    { id: "last", label: "Semana passada", range: (n) => { const s = addDays(startOfWeek(n), -7); return { from: s, to: lastDayOf(s, "week") }; } },
    { id: "last8", label: "Últimas 8 semanas", range: (n) => ({ from: addDays(startOfWeek(n), -49), to: lastDayOf(startOfWeek(n), "week") }) },
    { id: "last12", label: "Últimas 12 semanas", range: (n) => ({ from: addDays(startOfWeek(n), -77), to: lastDayOf(startOfWeek(n), "week") }) },
  ],
  month: [
    { id: "this", label: "Este mês", range: (n) => ({ from: startOfMonth(n), to: startOfDay(n) }) },
    { id: "last", label: "Mês passado", range: (n) => { const s = new Date(n.getFullYear(), n.getMonth() - 1, 1); return { from: s, to: new Date(n.getFullYear(), n.getMonth(), 0) }; } },
    { id: "last3", label: "Últimos 3 meses", range: (n) => ({ from: new Date(n.getFullYear(), n.getMonth() - 2, 1), to: startOfDay(n) }) },
    { id: "last6", label: "Últimos 6 meses", range: (n) => ({ from: new Date(n.getFullYear(), n.getMonth() - 5, 1), to: startOfDay(n) }) },
    { id: "last12", label: "Últimos 12 meses", range: (n) => ({ from: new Date(n.getFullYear(), n.getMonth() - 11, 1), to: startOfDay(n) }) },
    { id: "year", label: "Este ano", range: (n) => ({ from: new Date(n.getFullYear(), 0, 1), to: startOfDay(n) }) },
  ],
};

export function defaultPeriod(granularity: Granularity, now = new Date()): { from: Date; to: Date; presetId: string } {
  const preset =
    PERIOD_PRESETS[granularity].find((p) => p.id === (granularity === "day" ? "last30" : "last6")) ??
    PERIOD_PRESETS[granularity][0];
  return { ...preset.range(now), presetId: preset.id };
}

/** Desloca o intervalo uma unidade para trás/adiante (`dir` = -1 / +1), mantendo o tamanho. */
export function shiftPeriod(from: Date, to: Date, granularity: Granularity, dir: number): { from: Date; to: Date } {
  if (granularity === "month") {
    const start = startOfMonth(from);
    const spanMonths = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    const nextFrom = new Date(start.getFullYear(), start.getMonth() + dir, 1);
    // dia 0 do mês seguinte = último dia do mês — é assim que o intervalo fecha certinho.
    const nextTo = new Date(nextFrom.getFullYear(), nextFrom.getMonth() + spanMonths + 1, 0);
    return { from: nextFrom, to: nextTo };
  }
  const step = granularity === "week" ? 7 * dir : dir;
  return { from: addDays(from, step), to: addDays(to, step) };
}
