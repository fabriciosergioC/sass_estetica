export const BUSINESS_TIME_ZONE = "America/Sao_Paulo";

export function localDateTime(date: string, time: string): Date {
  const dateMatch = /^\d{4}-\d{2}-\d{2}$/.exec(date);
  const timeMatch = /^\d{2}:\d{2}$/.exec(time);
  if (!dateMatch || !timeMatch) throw new Error("Data ou horário inválido.");
  return new Date(`${date}T${time}:00-03:00`);
}

export function formatBusinessTime(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: BUSINESS_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

export function isBusinessSameDay(left: Date | string, right: Date | string = new Date()): boolean {
  const formatDay = (value: Date | string) => new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof value === "string" ? new Date(value) : value);
  return formatDay(left) === formatDay(right);
}
