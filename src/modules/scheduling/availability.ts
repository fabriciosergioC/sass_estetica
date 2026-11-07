import { db } from "@/lib/db";

export const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;

const ACTIVE_STATUSES = ["SCHEDULED", "CONFIRMED", "IN_SERVICE"];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fmtHHMM(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
  const weekday = day.getDay();
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

  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

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

  const busy = [
    ...appointments.map((a) => ({
      start: a.startAt.getHours() * 60 + a.startAt.getMinutes(),
      end: a.endAt.getHours() * 60 + a.endAt.getMinutes(),
    })),
    ...timeOffs.map((t) => {
      const isSameDayStart =
        t.startAt.getFullYear() === dayStart.getFullYear() &&
        t.startAt.getMonth() === dayStart.getMonth() &&
        t.startAt.getDate() === dayStart.getDate();
      const isEndsNextDay = t.endAt.getTime() >= dayEnd.getTime();
      return {
        start: isSameDayStart ? t.startAt.getHours() * 60 + t.startAt.getMinutes() : 0,
        end: isEndsNextDay ? 24 * 60 : t.endAt.getHours() * 60 + t.endAt.getMinutes(),
      };
    }),
  ];

  const slots: Slot[] = [];
  const now = new Date();
  const isToday =
    now.getFullYear() === dayStart.getFullYear() &&
    now.getMonth() === dayStart.getMonth() &&
    now.getDate() === dayStart.getDate();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  for (let start = window.openMin; start + durationMin <= window.closeMin; start += step) {
    const end = start + durationMin;

    if (isToday && start <= nowMin) {
      slots.push({ start: fmtHHMM(new Date(dayStart.getTime() + start * 60000)), available: false, reason: "passado" });
      continue;
    }
    if (window.breakStart !== null && window.breakEnd !== null && overlaps(start, end, window.breakStart, window.breakEnd)) {
      slots.push({ start: fmtHHMM(new Date(dayStart.getTime() + start * 60000)), available: false, reason: "pausa" });
      continue;
    }
    const conflict = busy.find((b) => overlaps(start, end, b.start, b.end));
    if (conflict) {
      slots.push({ start: fmtHHMM(new Date(dayStart.getTime() + start * 60000)), available: false, reason: "ocupado" });
      continue;
    }
    slots.push({ start: fmtHHMM(new Date(dayStart.getTime() + start * 60000)), available: true });
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
    throw new Error(`CONFLITO:${fmtHHMM(conflict.startAt)}`);
  }

  const day = new Date(startAt);
  const window = await workingWindow(orgId, barberId, day);
  if (!window) throw new Error("FORA_DO_HORARIO:O atendente não atende neste dia.");
  const startMin = startAt.getHours() * 60 + startAt.getMinutes();
  const endMin = endAt.getHours() * 60 + endAt.getMinutes();
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
  if (timeOff && overlaps(startMin, endMin, timeOff.startAt.getHours() * 60 + timeOff.startAt.getMinutes(), timeOff.endAt.getHours() * 60 + timeOff.endAt.getMinutes())) {
    throw new Error("FORA_DO_HORARIO:O atendente está de folga neste período.");
  }
}
