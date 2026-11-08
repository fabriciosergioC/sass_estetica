import { db } from "@/lib/db";

export const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;

const ACTIVE_STATUSES = ["SCHEDULED", "CONFIRMED", "IN_SERVICE"];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function zonedParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function fmtHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export type Slot = {
  start: string; // HH:MM local
  available: boolean;
  reason?: string;
};

/** Janela de funcionamento efetiva (barbeiro > padrão da org) para um dia. */
async function workingWindow(orgId: string, barberId: string, day: Date) {
  const dayKey = zonedParts(day).dateKey;
  const [year, month, dayOfMonth] = dayKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
  const hours = await db.businessHour.findMany({
    where: { orgId, weekday, OR: [{ barberId }, { barberId: null }] },
  });
  const own = hours.find((h) => h.barberId === barberId);
  const orgDefault = hours.find((h) => h.barberId === null);
  const rule = own ?? orgDefault;
  if (!rule || rule.closed) return null;
  return {
    openMin: minutesOf(rule.openTime),
    closeMin: minutesOf(rule.closeTime),
    breakStart: rule.breakStart ? minutesOf(rule.breakStart) : null,
    breakEnd: rule.breakEnd ? minutesOf(rule.breakEnd) : null,
  };
}

/**
 * Calcula slots de um barbeiro num dia, marcando disponibilidade.
 * Regras: horário de funcionamento, pausa, folgas, agendamentos ativos, granularidade da org.
 */
export async function getAvailability(opts: {
  orgId: string;
  barberId: string;
  date: Date; // dia local
  durationMin: number;
}): Promise<Slot[]> {
  const { orgId, barberId, date, durationMin } = opts;
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  const step = org.slotStepMin;

  const window = await workingWindow(orgId, barberId, date);
  if (!window) return [];

  const selectedKey = zonedParts(date).dateKey;
  const [year, month, dayOfMonth] = selectedKey.split("-").map(Number);
  const dayStart = new Date(Date.UTC(year, month - 1, dayOfMonth));
  const dayEnd = new Date(Date.UTC(year, month - 1, dayOfMonth + 1));

  const [appointments, timeOffs] = await Promise.all([
    db.appointment.findMany({
      where: {
        orgId,
        barberId,
        startAt: { lt: dayEnd },
        endAt: { gt: dayStart },
        status: { in: ACTIVE_STATUSES },
      },
      select: { startAt: true, endAt: true },
    }),
    db.barberTimeOff.findMany({
      where: { orgId, barberId, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      select: { startAt: true, endAt: true },
    }),
  ]);

  const selectedDateKey = selectedKey;
  const busy = [
    ...appointments.map((a) => {
      const start = zonedParts(a.startAt);
      const end = zonedParts(a.endAt);
      return {
        start: start.dateKey === selectedDateKey ? start.minute : 0,
        end: end.dateKey === selectedDateKey ? end.minute : 24 * 60,
      };
    }),
    ...timeOffs.map((t) => {
      const start = zonedParts(t.startAt);
      const end = zonedParts(t.endAt);
      return {
        start: start.dateKey === selectedDateKey ? start.minute : 0,
        end: end.dateKey === selectedDateKey ? end.minute : 24 * 60,
      };
    }),
  ];

  const slots: Slot[] = [];

  for (let start = window.openMin; start + durationMin <= window.closeMin; start += step) {
    const end = start + durationMin;

    const slotInstant = new Date(`${selectedDateKey}T${fmtHHMM(start)}:00-03:00`);
    if (slotInstant.getTime() <= Date.now()) {
      slots.push({ start: fmtHHMM(start), available: false, reason: "passado" });
      continue;
    }
    if (window.breakStart !== null && window.breakEnd !== null && overlaps(start, end, window.breakStart, window.breakEnd)) {
      slots.push({ start: fmtHHMM(start), available: false, reason: "pausa" });
      continue;
    }
    const conflict = busy.find((b) => overlaps(start, end, b.start, b.end));
    if (conflict) {
      slots.push({ start: fmtHHMM(start), available: false, reason: "ocupado" });
      continue;
    }
    slots.push({ start: fmtHHMM(start), available: true });
  }

  return slots;
}

/** Valida se um horário específico está livre. Lança erro com mensagem amigável. */
export async function assertSlotFree(opts: {
  orgId: string;
  barberId: string;
  startAt: Date;
  endAt: Date;
  ignoreAppointmentId?: string;
}): Promise<void> {
  const { orgId, barberId, startAt, endAt, ignoreAppointmentId } = opts;

  const conflict = await db.appointment.findFirst({
    where: {
      orgId,
      barberId,
      status: { in: ACTIVE_STATUSES },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(ignoreAppointmentId ? { id: { not: ignoreAppointmentId } } : {}),
    },
    select: { id: true, startAt: true },
  });
  if (conflict) {
    throw new Error(`CONFLITO:${fmtHHMM(zonedParts(conflict.startAt).minute)}`);
  }

  const day = new Date(startAt);
  const window = await workingWindow(orgId, barberId, day);
  if (!window) throw new Error("FORA_DO_HORARIO:O atendente não atende neste dia.");
  const startMin = zonedParts(startAt).minute;
  const endMin = zonedParts(endAt).minute;
  if (startMin < window.openMin || endMin > window.closeMin) {
    throw new Error("FORA_DO_HORARIO:Fora do horário de funcionamento.");
  }
  if (window.breakStart !== null && window.breakEnd !== null && overlaps(startMin, endMin, window.breakStart, window.breakEnd)) {
    throw new Error("FORA_DO_HORARIO:Conflita com o intervalo do atendente.");
  }

  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const timeOff = await db.barberTimeOff.findFirst({
    where: { orgId, barberId, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
  });
  if (timeOff && overlaps(startMin, endMin, zonedParts(timeOff.startAt).minute, zonedParts(timeOff.endAt).minute)) {
    throw new Error("FORA_DO_HORARIO:O atendente está de folga neste período.");
  }
}
