export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function parseBRLToCents(raw: string): number {
  const normalized = raw.replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}

export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length === 13) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

export const STATUS_META: Record<
  string,
  { label: string; tone: "gold" | "green" | "red" | "amber" | "blue" | "neutral"; bar: string }
> = {
  SCHEDULED: { label: "Agendado", tone: "blue", bar: "bg-sky-500" },
  CONFIRMED: { label: "Confirmado", tone: "gold", bar: "bg-gold-500" },
  IN_SERVICE: { label: "Em atendimento", tone: "amber", bar: "bg-amber-500" },
  COMPLETED: { label: "Concluído", tone: "green", bar: "bg-emerald-500" },
  CANCELLED: { label: "Cancelado", tone: "red", bar: "bg-red-500" },
  NO_SHOW: { label: "Faltou", tone: "red", bar: "bg-red-500" },
  RESCHEDULED: { label: "Reagendado", tone: "neutral", bar: "bg-zinc-500" },
};

export const SEGMENT_META: Record<string, { label: string; tone: "gold" | "green" | "red" | "amber" | "blue" | "neutral" }> = {
  NEW: { label: "Novo", tone: "blue" },
  RECURRENT: { label: "Recorrente", tone: "green" },
  VIP: { label: "VIP", tone: "gold" },
  INACTIVE: { label: "Inativo", tone: "red" },
  RETURN_DUE: { label: "Retorno devido", tone: "amber" },
};

export function formatDateLong(d: Date | string): string {
  const date = typeof d === "string" ? new Date(`${d}T12:00:00`) : d;
  return date.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
}

/**
 * Data curta para as linhas da Agenda: "sex 24/10".
 *
 * O `pt-BR` escreve o dia da semana abreviado com ponto e vírgula ("sex., 24/10"); dentro de uma
 * coluna de ~96px isso quebra a linha, então os sinais são removidos e sobra só o rótulo.
 * Aceita `Date` ou o ISO que vem do servidor — quem chama a Agenda tem as duas formas à mão.
 */
export function formatDateShort(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d
    .toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })
    .replace(/[.,]/g, "");
}

export function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatTimeHHMM(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
