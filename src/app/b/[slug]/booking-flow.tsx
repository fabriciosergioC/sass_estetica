"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type OrgInfo = {
  name: string;
  slug: string;
  primaryColor: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  instagram: string | null;
  phone: string | null;
  whatsapp: string | null;
};

type Svc = { id: string; name: string; category: string; durationMin: number; priceCents: number; description: string | null };
type Brb = { id: string; name: string; bio: string | null; specialties: string; serviceIds: string[] };
type Slot = { start: string; available: boolean; reason?: string };

const STEPS = ["Serviço", "Atendente", "Data", "Horário", "Seus dados"];
const WEEKDAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function brl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function toDateInput(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Telefone cadastrado → link do WhatsApp. Aceita "(31) 9...", "5531..." ou "+55 31...";
 * abaixo de 12 dígitos assumimos que falta o DDI (55), o que também protege números
 * com DDD 55 (RS), que têm só 11 dígitos.
 */
function whatsappHref(raw: string | null): string | null {
  const digits = raw?.replace(/\D/g, "") ?? "";
  if (!digits) return null;
  return `https://wa.me/${digits.length >= 12 ? digits : `55${digits}`}`;
}

/**
 * Instagram cadastrado → link do perfil. Aceita a URL completa, o usuário com
 * "@" ou só o nome do perfil; o painel permite qualquer um dos formatos.
 */
function instagramHref(raw: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const handle = value.replace(/^@+/, "").trim();
  return handle ? `https://www.instagram.com/${handle}` : null;
}

export function PublicBooking({ org }: { org: OrgInfo }) {
  const [services, setServices] = useState<Svc[]>([]);
  const [barbers, setBarbers] = useState<Brb[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [step, setStep] = useState(1);
  const [service, setService] = useState<Svc | null>(null);
  const [barber, setBarber] = useState<Brb | null>(null);
  const [date, setDate] = useState<string>(toDateInput(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<null | { serviceName: string; barberName: string; date: string; time: string; priceCents: number }>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/${org.slug}/config`);
        const data = await res.json();
        if (!res.ok) return setLoadError(data.error ?? "Não foi possível carregar.");
        setServices(data.services);
        setBarbers(data.barbers);
      } catch {
        setLoadError("Não foi possível carregar. Verifique sua conexão.");
      } finally {
        setLoading(false);
      }
    })();
  }, [org.slug]);

  const eligibleBarbers = useMemo(
    () => {
      if (!service) return barbers;
      // Se o barbeiro tem vínculos específicos com serviços (serviceIds), filtra por eles.
      // Caso não tenha nenhum vínculo cadastrado na tabela de relacionamento (serviceIds vazio), assume que ele realiza todos os serviços.
      return barbers.filter((b) => b.serviceIds.length === 0 || b.serviceIds.includes(service.id));
    },
    [barbers, service]
  );

  const loadSlots = useCallback(async () => {
    if (!service || !barber || !date) return;
    setSlotsLoading(true);
    setTime("");
    try {
      const res = await fetch(
        `/api/public/${org.slug}/slots?serviceId=${service.id}&barberId=${barber.id}&date=${date}`
      );
      const data = await res.json();
      setSlots(res.ok ? data.slots : []);
    } catch {
      setSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }, [org.slug, service, barber, date]);

  useEffect(() => {
    if (step === 4) loadSlots();
  }, [step, loadSlots]);

  async function submit() {
    setError("");
    if (name.trim().length < 2) return setError("Informe seu nome completo.");
    if (phone.replace(/\D/g, "").length < 10) return setError("Informe um telefone válido com DDD.");
    if (!service || !barber || !time) return setError("Selecione serviço, atendente e horário.");

    setSaving(true);
    try {
      const res = await fetch(`/api/public/${org.slug}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          barberId: barber.id,
          date,
          time,
          name: name.trim(),
          phone: phone.trim(),
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Não foi possível agendar. Tente novamente.");
        if (String(data.error ?? "").includes("ocupado") || String(data.error ?? "").includes("horário")) {
          setStep(4);
          loadSlots();
        }
        return;
      }
      setDone(data.appointment);
    } catch {
      setError("Não foi possível agendar. Verifique sua conexão.");
    } finally {
      setSaving(false);
    }
  }

  function restart() {
    setDone(null);
    setStep(1);
    setService(null);
    setBarber(null);
    setDate(toDateInput(new Date()));
    setTime("");
    setName("");
    setPhone("");
    setNotes("");
    setError("");
  }

  const accent = org.primaryColor;
  // O backend novo sempre manda "whatsapp"; em registros antigos só há "phone".
  const waHref = whatsappHref(org.whatsapp ?? org.phone);
  const igHref = instagramHref(org.instagram);
  const todayStr = toDateInput(new Date());
  const [y, m, d] = date.split("-").map(Number);
  const dateLabel = d && m
    ? `${WEEKDAY_LABELS[new Date(y, m - 1, d).getDay()]}, ${d} de ${MONTHS[m - 1]}`
    : "";

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <p className="animate-pulse text-sm text-zinc-500">Carregando...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6 text-center">
        <p className="text-sm text-zinc-400">{loadError}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10 text-center">
        <div
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-3xl"
          style={{ backgroundColor: `${accent}22`, color: accent }}
        >
          ✓
        </div>
        <h1 className="mt-5 text-2xl font-semibold">Agendamento confirmado!</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Te esperamos na {org.name}. Chegue com alguns minutos de antecedência.
        </p>
        <div className="mt-6 space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left text-sm">
          <div className="flex justify-between"><span className="text-zinc-500">Serviço</span><span className="font-medium">{done.serviceName}</span></div>
          <div className="flex justify-between"><span className="text-zinc-500">Profissional</span><span className="font-medium">{done.barberName}</span></div>
          <div className="flex justify-between"><span className="text-zinc-500">Quando</span><span className="font-medium">{done.date.split("-").reverse().join("/")} às {done.time}</span></div>
          <div className="flex justify-between"><span className="text-zinc-500">Valor</span><span className="font-medium" style={{ color: accent }}>{brl(done.priceCents)}</span></div>
        </div>
        <button
          onClick={restart}
          className="mt-6 rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-200 hover:border-zinc-500"
        >
          Fazer outro agendamento
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-5 pb-16">
      <header className="pt-10 pb-6 text-center">
        <div
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
          style={{ backgroundColor: `${accent}1f`, color: accent }}
        >
          {/* Brilho (estética) em SVG, e não emoji: assim ele herda a `color: accent` do bloco e
              fica com a cor da clínica, coisa que o emoji de tesoura nunca fez. */}
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M11 2.5 12.9 8l5.6 1.9-5.6 1.9L11 17.3 9.1 11.8 3.5 9.9 9.1 8z" />
            <path d="M17.8 13.6l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1z" />
          </svg>
        </div>
        <h1 className="mt-3 text-xl font-semibold">{org.name}</h1>
        {org.description && <p className="mt-1 text-sm text-zinc-500">{org.description}</p>}
        {(org.city || org.state) && (
          <p className="mt-1 text-xs text-zinc-600">
            {org.city}{org.city && org.state ? " · " : ""}{org.state}
          </p>
        )}
        {(waHref || igHref) && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {waHref && (
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-zinc-950 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                style={{ backgroundColor: accent }}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.96L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.26 8.26 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 4.54 0 8.24 3.7 8.24 8.24 0 4.55-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.16.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.15.16-.25.25-.42.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.87.85-.87 2.07 0 1.22.89 2.39 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.14-1.18-.06-.11-.22-.17-.47-.29z" />
                </svg>
                Falar no WhatsApp
              </a>
            )}
            {igHref && (
              <a
                href={igHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors hover:bg-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                style={{ borderColor: accent, color: accent }}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="5" />
                  <circle cx="12" cy="12" r="4" />
                  <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
                </svg>
                Instagram
              </a>
            )}
          </div>
        )}
      </header>

      <ol className="mb-6 flex items-center justify-between">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const isDone = n < step;
          const isCurrent = n === step;
          return (
            <li key={label} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition-colors"
                  style={
                    isCurrent
                      ? { backgroundColor: accent, borderColor: accent, color: "#0a0a0a" }
                      : isDone
                        ? { backgroundColor: `${accent}33`, borderColor: `${accent}66`, color: accent }
                        : { borderColor: "#3f3f46", color: "#71717a" }
                  }
                >
                  {isDone ? "✓" : n}
                </div>
                <span className={`text-[10px] ${isCurrent ? "text-zinc-200" : "text-zinc-600"}`}>{label}</span>
              </div>
              {n < STEPS.length && <div className={`mx-1 mb-4 h-px flex-1 ${isDone ? "" : "bg-zinc-800"}`} style={isDone ? { backgroundColor: `${accent}66` } : undefined} />}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-300">Escolha o serviço</h2>
          {services.map((s) => (
            <button
              key={s.id}
              onClick={() => { setService(s); setBarber(null); setStep(2); }}
              className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left hover:border-zinc-600"
            >
              <div>
                <p className="font-medium">{s.name}</p>
                <p className="text-xs text-zinc-500">{s.durationMin} min {s.category ? `· ${s.category}` : ""}</p>
              </div>
              <span className="font-semibold" style={{ color: accent }}>{brl(s.priceCents)}</span>
            </button>
          ))}
        </section>
      )}

      {step === 2 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-300">Com quem quer atender-se?</h2>
          {eligibleBarbers.length === 0 && (
            <p className="rounded-xl border border-zinc-800 p-4 text-sm text-zinc-500">
              Nenhum profissional executa este serviço no momento.
            </p>
          )}
          {eligibleBarbers.map((b) => (
            <button
              key={b.id}
              onClick={() => { setBarber(b); setStep(3); }}
              className="flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left hover:border-zinc-600"
            >
              <div
                className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-semibold"
                style={{ backgroundColor: `${accent}1f`, color: accent }}
              >
                {b.name.slice(0, 1)}
              </div>
              <div>
                <p className="font-medium">{b.name}</p>
                {b.specialties && <p className="text-xs text-zinc-500">{b.specialties}</p>}
              </div>
            </button>
          ))}
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-300">Escolha o dia</h2>
          <input
            type="date"
            value={date}
            min={todayStr}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 [color-scheme:dark]"
          />
          <button
            onClick={() => setStep(4)}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium text-zinc-950 disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            Ver horários
          </button>
        </section>
      )}

      {step === 4 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-300">Horários para {dateLabel}</h2>
            <button onClick={loadSlots} className="text-xs text-zinc-500 hover:text-zinc-300">atualizar</button>
          </div>
          {slotsLoading ? (
            <div className="grid grid-cols-4 gap-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-900" />
              ))}
            </div>
          ) : slots.filter((s) => s.available).length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center">
              <p className="text-sm text-zinc-400">Sem horários livres neste dia.</p>
              <button onClick={() => setStep(3)} className="mt-2 text-xs underline" style={{ color: accent }}>
                escolher outro dia
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {slots.map((s) => (
                <button
                  key={s.start}
                  disabled={!s.available}
                  onClick={() => { setTime(s.start); setStep(5); }}
                  className={`rounded-lg border px-2 py-2 text-sm ${
                    s.available
                      ? "border-zinc-700 text-zinc-100 hover:border-zinc-400"
                      : "border-zinc-900 text-zinc-700 line-through"
                  }`}
                >
                  {s.start}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {step === 5 && (
        <section className="space-y-4">
          <div className="rounded-xl border p-3 text-sm" style={{ borderColor: `${accent}44`, backgroundColor: `${accent}0d` }}>
            <p className="font-medium">{service?.name} · {barber?.name}</p>
            <p className="mt-0.5 text-xs text-zinc-400">{dateLabel} às {time} · {brl(service?.priceCents ?? 0)}</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-400">Seu nome</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como podemos te chamar?"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-400">WhatsApp</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="(11) 99999-9999"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-400">Observação (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Alguma preferência?"
              className="min-h-16 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            onClick={submit}
            disabled={saving}
            className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {saving ? "Confirmando..." : "Confirmar agendamento"}
          </button>
        </section>
      )}

      {step > 1 && (
        <button onClick={() => setStep(step - 1)} className="mt-6 text-sm text-zinc-500 hover:text-zinc-300">
          ← voltar
        </button>
      )}

      <footer className="mt-12 border-t border-zinc-900 pt-4 text-center text-xs text-zinc-600">
        {/* Só o endereço: os contatos ficam nos botões do topo. */}
        {org.address && <p>{org.address}</p>}
      </footer>
    </div>
  );
}
