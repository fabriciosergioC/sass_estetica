"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/toast";
import { SlotPicker } from "@/app/app/agenda/slot-picker";
import { toDateInput, formatTimeHHMM, STATUS_META } from "@/lib/format";

type ServiceOption = { id: string; name: string; durationMin: number; priceCents: number; category: string };
type BarberOption = { id: string; name: string; serviceIds: string[] };

type Upcoming = {
  id: string;
  startAt: string;
  status: string;
  serviceName: string;
  durationMin: number;
  barberName: string;
  priceCents: number;
  notes: string | null;
};

type Historico = {
  id: string;
  startAt: string;
  status: string;
  serviceName: string;
  barberName: string;
  priceCents: number;
};

type PainelProps = {
  slug: string;
  accent: string;
  cliente: { id: string; name: string; phone: string };
  /** Aba inicial vinda da rota: /painel = inicio, /agendar, /meus-agendamentos, /historico */
  initialTab?: "inicio" | "agendar" | "meus" | "historico";
};

const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-[color:var(--accent-c)] px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:opacity-90 disabled:opacity-50";

function brl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function cardStyle(isActive: boolean) {
  return `rounded-xl border bg-zinc-900/60 p-4 text-left transition-colors hover:border-zinc-600 ${
    isActive ? "border-[color:var(--accent-c)]" : "border-zinc-800"
  }`;
}

/** Conteúdo do /c/{slug}/painel — resumo, agendamento, lista de agendamentos. */
export function PainelClientes({ slug, accent: _accent, cliente, initialTab = "inicio" }: PainelProps) {
  const [tab, setTab] = useState<"inicio" | "agendar" | "meus" | "historico">(initialTab);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [barbers, setBarbers] = useState<BarberOption[]>([]);
  const [upcoming, setUpcoming] = useState<Upcoming[]>([]);
  const [historico, setHistorico] = useState<Historico[]>([]);
  const [resumo, setResumo] = useState<{ visitas: number; totalGasto: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const [service, setService] = useState<ServiceOption | null>(null);
  const [barber, setBarber] = useState<BarberOption | null>(null);
  const [date, setDate] = useState(toDateInput(new Date()));
  const [time, setTime] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, me] = await Promise.all([
        fetch(`/api/cliente-portal/${slug}/config`),
        fetch(`/api/cliente-portal/${slug}/me`),
      ]);
      const cfgData = await cfg.json();
      const meData = await me.json().catch(() => ({}));
      if (resDataOk(meData)) {
        setUpcoming(meData.upcoming ?? []);
        setHistorico(meData.historico ?? []);
        setResumo(meData.resumo ?? null);
      }
      setServices(cfgData.services ?? []);
      setBarbers(cfgData.barbers ?? []);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  function resDataOk(d: unknown): d is { upcoming?: Upcoming[]; historico?: Historico[]; resumo?: { visitas: number; totalGasto: string } } {
    return !!d && typeof d === "object";
  }

  const eligibleBarbers = useMemo(
    () => (service ? barbers.filter((b) => b.serviceIds.includes(service.id)) : []),
    [barbers, service]
  );

  async function book() {
    if (!service || !barber || !time) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cliente-portal/${slug}/appointments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "book",
          serviceId: service.id,
          barberId: barber.id,
          date,
          time,
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível agendar.", "error");
        setTime(null);
        return;
      }
      toast("Agendamento confirmado! Te esperamos na clínica.");
      setService(null);
      setBarber(null);
      setTime(null);
      setNotes("");
      setTab("meus");
      void load();
    } catch {
      toast("Falha de conexão. Tente novamente.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function cancelAppointment(id: string) {
    const res = await fetch(`/api/cliente-portal/${slug}/appointments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", appointmentId: id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast(data.error ?? "Não foi possível cancelar.", "error");
      return;
    }
    toast("Agendamento cancelado.");
    void load();
  }

  const TABS = [
    { key: "inicio", label: "Início", icon: "🏠" },
    { key: "agendar", label: "Agendar", icon: "📅" },
    { key: "meus", label: "Meus", icon: "🔖" },
    { key: "historico", label: "Histórico", icon: "🕘" },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Olá, {cliente.name.split(" ")[0]}! 👋</h1>
          <p className="mt-1 text-sm text-zinc-500">Sua área de agendamentos na clínica.</p>
        </div>
        <button onClick={() => { setTab("agendar"); }} className={`${btnPrimary}`}>
          + Novo agendamento
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-xs text-zinc-500">Próximo agendamento</p>
          <p className="mt-1 text-lg font-semibold">
            {upcoming[0]
              ? formatTimeHHMM(upcoming[0].startAt)
              : "—"}
          </p>
          <p className="text-xs text-zinc-500">
            {upcoming[0]
              ? new Date(upcoming[0].startAt).toLocaleDateString("pt-BR")
              : "Nenhum agendado"}
          </p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-xs text-zinc-500">Visitas concluídas</p>
          <p className="mt-1 text-lg font-semibold">{resumo?.visitas ?? 0}</p>
          <p className="text-xs text-zinc-500">Fidelidade</p>
        </div>
        <div className="col-span-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 sm:col-span-1">
          <p className="text-xs text-zinc-500">Total investido</p>
          <p className="mt-1 text-lg font-semibold text-[color:var(--accent-c)]">
            {resumo?.totalGasto ?? "—"}
          </p>
          <p className="text-xs text-zinc-500">Histórico de pagamentos</p>
        </div>
      </div>

      {/* Tabs inferiores (mobile-first, mesma estética dos botões do painel) */}
      <div className="flex gap-1 overflow-x-auto rounded-lg bg-zinc-950 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-[color:var(--accent-c)] text-zinc-950"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl bg-zinc-900/60" />
      ) : tab === "inicio" ? (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Próximos agendamentos</h2>
          {upcoming.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
              <p className="text-sm text-zinc-500">Você ainda não tem agendamentos futuros.</p>
              <button onClick={() => setTab("agendar")} className="mt-3 text-sm text-[color:var(--accent-c)] underline">
                Agendar agora
              </button>
            </div>
          ) : (
            upcoming.map((a) => (
              <div key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{a.serviceName}</p>
                    <p className="text-sm text-zinc-400">
                      {new Date(a.startAt).toLocaleDateString("pt-BR")} às {formatTimeHHMM(a.startAt)} · {a.barberName}
                    </p>
                    {a.notes && <p className="mt-1 text-xs text-zinc-600">📝 {a.notes}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge tone={STATUS_META[a.status]?.tone ?? "neutral"}>{STATUS_META[a.status]?.label ?? a.status}</Badge>
                    <span className="text-sm font-medium">{brl(a.priceCents)}</span>
                  </div>
                </div>
                <button
                  onClick={() => cancelAppointment(a.id)}
                  className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20"
                >
                  Cancelar agendamento
                </button>
              </div>
            ))
          )}
        </div>
      ) : tab === "agendar" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-zinc-300">1. Escolha o serviço</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {services.map((s) => (
                <button key={s.id} onClick={() => { setService(s); setBarber(null); setTime(null); }} className={cardStyle(service?.id === s.id)}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-zinc-500">{s.durationMin} min · {s.category}</p>
                    </div>
                    <span className="font-semibold text-[color:var(--accent-c)]">{brl(s.priceCents)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {service && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-zinc-300">2. Escolha o profissional</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {eligibleBarbers.map((b) => (
                  <button key={b.id} onClick={() => { setBarber(b); setTime(null); }} className={cardStyle(barber?.id === b.id)}>
                    <div className="flex items-center gap-2">
                      <div
                        className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold"
                        style={{ backgroundColor: "color-mix(in srgb, var(--accent-c) 15%, transparent)", color: "var(--accent-c)" }}
                      >
                        {b.name.slice(0, 1)}
                      </div>
                      <p className="truncate text-sm font-medium">{b.name}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {service && barber && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-zinc-300">3. Escolha o dia e horário</h3>
              <input
                type="date"
                value={date}
                min={toDateInput(new Date())}
                onChange={(e) => { setDate(e.target.value); setTime(null); }}
                className="w-full max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 [color-scheme:dark]"
              />
              <SlotPicker
                barberId={barber.id}
                serviceId={service.id}
                date={date}
                selected={time}
                onSelect={setTime}
                endpoint={`/api/cliente-portal/${slug}/slots`}
              />
              {time && (
                <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">Confirmar</p>
                    <p className="text-sm text-zinc-400">
                      {service.name} · {barber.name} · {formatTimeHHMM(new Date(`${date}T${time}:00`))} ·{" "}
                      <span className="text-[color:var(--accent-c)]">{brl(service.priceCents)}</span>
                    </p>
                  </div>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Observação (opcional)"
                    className="min-h-16 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                  <button onClick={book} disabled={saving} className={`${btnPrimary} w-full`}>
                    {saving ? "Confirmando..." : "Confirmar agendamento"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : tab === "meus" ? (
        <div className="space-y-3">
          {upcoming.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
              <p className="text-sm text-zinc-500">Você não tem agendamentos futuros.</p>
              <button onClick={() => setTab("agendar")} className="mt-3 text-sm text-[color:var(--accent-c)] underline">
                Agendar agora
              </button>
            </div>
          ) : (
            upcoming.map((a) => (
              <div key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{a.serviceName}</p>
                    <p className="text-sm text-zinc-400">
                      {new Date(a.startAt).toLocaleDateString("pt-BR")} às {formatTimeHHMM(a.startAt)} · {a.barberName}
                    </p>
                    {a.notes && <p className="mt-1 text-xs text-zinc-600">📝 {a.notes}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge tone={STATUS_META[a.status]?.tone ?? "neutral"}>{STATUS_META[a.status]?.label ?? a.status}</Badge>
                    <span className="text-sm font-medium">{brl(a.priceCents)}</span>
                  </div>
                </div>
                <button
                  onClick={() => cancelAppointment(a.id)}
                  className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20"
                >
                  Cancelar agendamento
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {historico.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              Seu histórico aparecerá aqui após a primeira visita.
            </p>
          ) : (
            historico.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div>
                  <p className="font-medium">{a.serviceName}</p>
                  <p className="text-sm text-zinc-400">
                    {new Date(a.startAt).toLocaleDateString("pt-BR")} às {formatTimeHHMM(a.startAt)} · {a.barberName}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={STATUS_META[a.status]?.tone ?? "neutral"}>{STATUS_META[a.status]?.label ?? a.status}</Badge>
                  <span className="text-sm font-medium">{brl(a.priceCents)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    gold: "border-[color-mix(in_srgb,var(--accent-c)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent-c)_12%,transparent)] text-[color:var(--accent-c)]",
    green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    blue: "border-sky-500/30 bg-sky-500/10 text-sky-400",
    red: "border-red-500/30 bg-red-500/10 text-red-400",
    neutral: "border-zinc-700 bg-zinc-800 text-zinc-400",
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone ?? "neutral"]}`}>
      {children}
    </span>
  );
}
