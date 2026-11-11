"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, Badge } from "@/components/ui";
import { toast } from "@/components/toast";
import { formatBRL, formatDateShort, formatTimeHHMM, STATUS_META, toDateInput } from "@/lib/format";
import { AppointmentDialog } from "./appointment-dialog";
import { RescheduleDialog, type RescheduleTarget } from "./reschedule-dialog";
import { PaymentDialog, type PaymentTarget } from "./payment-dialog";
import { paymentMethodLabel } from "@/lib/payment-methods";

type Appointment = {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  priceCents: number;
  notes: string | null;
  customer: { id: string; name: string; phone: string };
  barber: { id: string; name: string };
  service: { id: string; name: string; durationMin: number };
  payments: { id: string; method: string; amountCents: number; paidAt: string | null }[];
};

type BarberOption = { id: string; name: string };

/** Ações permitidas por status (espelha a máquina de transições do backend). */
function actionsFor(status: string): { to: string; label: string; variant: "primary" | "secondary" | "ghost" | "danger" }[] {
  switch (status) {
    case "SCHEDULED":
      return [
        { to: "CONFIRMED", label: "Confirmar", variant: "primary" },
        { to: "IN_SERVICE", label: "Iniciar", variant: "secondary" },
        { to: "COMPLETED", label: "Concluir", variant: "secondary" },
        { to: "CANCELLED", label: "Cancelar", variant: "danger" },
        { to: "NO_SHOW", label: "Faltou", variant: "ghost" },
      ];
    case "CONFIRMED":
      return [
        { to: "IN_SERVICE", label: "Iniciar", variant: "primary" },
        { to: "COMPLETED", label: "Concluir", variant: "secondary" },
        { to: "CANCELLED", label: "Cancelar", variant: "danger" },
        { to: "NO_SHOW", label: "Faltou", variant: "ghost" },
      ];
    case "IN_SERVICE":
      return [
        { to: "COMPLETED", label: "Concluir", variant: "primary" },
        { to: "NO_SHOW", label: "Faltou", variant: "danger" },
      ];
    default:
      return [];
  }
}

export default function AgendaPage() {
  const [date, setDate] = useState(() => toDateInput(new Date()));
  const [barberFilter, setBarberFilter] = useState("");
  const [barbers, setBarbers] = useState<BarberOption[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preselectCustomerId, setPreselectCustomerId] = useState<string | undefined>();
  const [rescheduleTarget, setRescheduleTarget] = useState<RescheduleTarget | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<PaymentTarget | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Estados de Tempo Real e Destaque Visual
  const [liveConnected, setLiveConnected] = useState(false);
  const [recentlyUpdatedId, setRecentlyUpdatedId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
    if (params.get("customerId")) {
      setPreselectCustomerId(params.get("customerId") ?? undefined);
      setDialogOpen(true);
    }
    fetch("/api/barbers?pageSize=100")
      .then((r) => r.json())
      .then((d) => setBarbers((d.items ?? []).filter((b: BarberOption & { active: boolean }) => b.active)));
  }, []);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) {
        setLoading(true);
      }
      try {
        const params = new URLSearchParams({ from: date, to: date });
        if (barberFilter) params.set("barberId", barberFilter);
        const res = await fetch(`/api/appointments?${params}`);
        const data = await res.json();
        setAppointments(data.items ?? []);
      } finally {
        if (!opts?.silent) {
          setLoading(false);
        }
      }
    },
    [date, barberFilter]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Conexão em tempo real via SSE + Polling de segurança silencioso
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      try {
        es = new EventSource("/api/appointments/events");

        es.onopen = () => {
          setLiveConnected(true);
        };

        es.addEventListener("ready", () => {
          setLiveConnected(true);
        });

        es.addEventListener("appointment.updated", (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data);
            if (payload?.appointmentId) {
              // Atualiza imediatamente o status na lista sem esperar refetch
              setAppointments((prev) =>
                prev.map((a) =>
                  a.id === payload.appointmentId ? { ...a, status: payload.status } : a
                )
              );
              setRecentlyUpdatedId(payload.appointmentId);
              setTimeout(() => setRecentlyUpdatedId(null), 2500);
            }
            // Sincroniza dados completos silenciosamente
            void load({ silent: true });
          } catch {}
        });

        es.addEventListener("appointment.created", () => {
          void load({ silent: true });
        });

        es.onerror = () => {
          setLiveConnected(false);
          es?.close();
          // Reconecta automaticamente em 3s
          reconnectTimeout = setTimeout(connect, 3000);
        };
      } catch {
        setLiveConnected(false);
      }
    }

    connect();

    // Polling de fallback a cada 5 segundos para garantir atualização contínua mesmo se a rede oscilar
    const pollInterval = setInterval(() => {
      void load({ silent: true });
    }, 5000);

    // Quando o usuário alterna entre abas e volta para a agenda, sincroniza na hora
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void load({ silent: true });
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);

    return () => {
      es?.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      clearInterval(pollInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, [load]);

  async function changeStatus(appt: Appointment, to: string) {
    setBusyId(appt.id);
    const previousStatus = appt.status;

    // 1. Atualização Otimista Imediata: muda o status na tela em tempo real sem latência
    setAppointments((prev) =>
      prev.map((a) => (a.id === appt.id ? { ...a, status: to } : a))
    );
    setRecentlyUpdatedId(appt.id);
    setTimeout(() => setRecentlyUpdatedId(null), 2500);

    try {
      const res = await fetch(`/api/appointments/${appt.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Reverte se a requisição falhar
        setAppointments((prev) =>
          prev.map((a) => (a.id === appt.id ? { ...a, status: previousStatus } : a))
        );
        toast(data.error ?? "Não foi possível atualizar o atendimento.", "error");
        return;
      }

      if (to === "COMPLETED") {
        if (data.whatsapp?.sent) {
          toast("Atendimento concluído. Mensagem de agradecimento enviada via WhatsApp!");
        } else if (data.whatsapp?.friendly) {
          toast(`Atendimento concluído. WhatsApp: ${data.whatsapp.friendly}`);
        } else {
          toast("Atendimento concluído. Registre o recebimento no atendimento.");
        }
      } else {
        const labels: Record<string, string> = {
          CONFIRMED: "Agendamento confirmado.",
          IN_SERVICE: "Atendimento iniciado.",
          CANCELLED: "Agendamento cancelado.",
          NO_SHOW: "Registrado como falta.",
        };
        toast(labels[to] ?? "Status atualizado.");
      }

      // Sincroniza em background silenciosamente mantendo a tela estável
      void load({ silent: true });
    } catch {
      // Reverte em caso de erro de rede
      setAppointments((prev) =>
        prev.map((a) => (a.id === appt.id ? { ...a, status: previousStatus } : a))
      );
      toast("Falha na conexão ao atualizar status.", "error");
    } finally {
      setBusyId(null);
    }
  }

  const stats = useMemo(() => {
    const active = appointments.filter((a) => ["SCHEDULED", "CONFIRMED", "IN_SERVICE"].includes(a.status));
    const done = appointments.filter((a) => a.status === "COMPLETED");
    // "Recebido" é o que entrou de verdade (Payment), não o preço do serviço: atendimento
    // concluído sem recebimento registrado não é dinheiro no caixa.
    const revenue = done.reduce((sum, a) => sum + (a.payments?.[0]?.amountCents ?? 0), 0);
    return { total: appointments.length, active: active.length, done: done.length, revenue };
  }, [appointments]);

  function shiftDate(days: number) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + days);
    setDate(toDateInput(d));
  }

  const dateLabel = new Date(`${date}T12:00:00`).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                liveConnected
                  ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border border-zinc-700 bg-zinc-800 text-zinc-400"
              }`}
              title={liveConnected ? "Sincronização em tempo real ativa" : "Conectando ao tempo real..."}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  liveConnected ? "animate-pulse bg-emerald-400" : "bg-zinc-500"
                }`}
              />
              Tempo real
            </span>
          </div>
          <p className="mt-1 text-sm capitalize text-zinc-500">{dateLabel}</p>
        </div>
        <Button
          onClick={() => {
            setPreselectCustomerId(undefined);
            setDialogOpen(true);
          }}
        >
          + Novo agendamento
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="secondary" onClick={() => shiftDate(-1)} aria-label="Dia anterior">
            ←
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-gold-500 focus:outline-none"
          />
          <Button variant="secondary" onClick={() => shiftDate(1)} aria-label="Próximo dia">
            →
          </Button>
          <Button variant="ghost" onClick={() => setDate(toDateInput(new Date()))}>
            Hoje
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 lg:ml-4">
          <button
            onClick={() => setBarberFilter("")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              barberFilter === "" ? "border-gold-500/60 bg-gold-500/10 text-gold-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Todos
          </button>
          {barbers.map((b) => (
            <button
              key={b.id}
              onClick={() => setBarberFilter(b.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                barberFilter === b.id ? "border-gold-500/60 bg-gold-500/10 text-gold-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="p-3">
          <p className="text-xs text-zinc-500">Agendamentos</p>
          <p className="text-xl font-semibold tabular-nums">{stats.total}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-zinc-500">Ativos</p>
          <p className="text-xl font-semibold tabular-nums">{stats.active}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-zinc-500">Concluídos</p>
          <p className="text-xl font-semibold tabular-nums">{stats.done}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-zinc-500">Recebido hoje</p>
          <p className="text-xl font-semibold tabular-nums text-gold-400">{formatBRL(stats.revenue)}</p>
        </Card>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-zinc-900" />
          ))}
        </div>
      ) : appointments.length === 0 ? (
        <EmptyState
          icon="🗓️"
          title="Nenhum agendamento neste dia"
          description="Aproveite para recuperar horários: contate clientes com retorno pendente."
          action={<Button onClick={() => setDialogOpen(true)}>Criar agendamento</Button>}
        />
      ) : (
        <div className="space-y-3">
          {appointments.map((a) => {
            const meta = STATUS_META[a.status];
            const isPast = new Date(a.startAt) < new Date();
            const isRecentlyUpdated = recentlyUpdatedId === a.id;

            return (
              <Card
                key={a.id}
                className={`animate-fade-up p-4 transition-all duration-300 ${
                  isRecentlyUpdated ? "border-gold-500/80 bg-gold-500/5 ring-1 ring-gold-500/50" : ""
                }`}
              >
                <div className="flex flex-wrap items-start gap-3">
                  {/*
                    A data vem do `startAt` da própria linha, não do filtro do dia: a lista hoje é
                    de um dia só, mas assim o card continua honesto se um atendimento virar de
                    madrugada (23:30 → 00:30) ou se a consulta passar a varrer mais de um dia.
                  */}
                  <div className="w-24 shrink-0 text-center">
                    <p className="text-lg font-semibold tabular-nums leading-tight">{formatTimeHHMM(a.startAt)}</p>
                    <p className="text-xs tabular-nums leading-tight text-zinc-500">
                      → {formatTimeHHMM(a.endAt)}
                    </p>
                    <p className="mt-0.5 text-[11px] tabular-nums text-zinc-600">{a.service.durationMin}min</p>
                    <p className="text-[11px] tabular-nums text-zinc-600">{formatDateShort(a.startAt)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/app/clientes/${a.customer.id}`} className="font-medium hover:text-gold-300">
                        {a.customer.name}
                      </Link>
                      <Badge tone={meta?.tone ?? "neutral"}>{meta?.label ?? a.status}</Badge>
                      {isPast && ["SCHEDULED", "CONFIRMED"].includes(a.status) && (
                        <Badge tone="amber">horário passando</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-zinc-400">
                      {a.service.name} · {a.barber.name} · <span className="text-gold-400">{formatBRL(a.priceCents)}</span>
                    </p>
                    {a.notes && <p className="mt-1 text-xs text-zinc-500">📝 {a.notes}</p>}
                  </div>
                </div>
                {actionsFor(a.status).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
                    {actionsFor(a.status).map((action) => (
                      <Button
                        key={action.to}
                        variant={action.variant}
                        disabled={busyId === a.id}
                        onClick={() => changeStatus(a, action.to)}
                        className="!px-3 !py-1.5 !text-xs"
                      >
                        {action.label}
                      </Button>
                    ))}
                    {["SCHEDULED", "CONFIRMED"].includes(a.status) && (
                      <Button
                        variant="outline"
                        disabled={busyId === a.id}
                        onClick={() =>
                          setRescheduleTarget({
                            id: a.id,
                            label: `${a.customer.name} · ${a.service.name}`,
                            barberId: a.barber.id,
                            startAt: a.startAt,
                            durationMin: a.service.durationMin,
                          })
                        }
                        className="!px-3 !py-1.5 !text-xs"
                      >
                        Reagendar
                      </Button>
                    )}
                  </div>
                )}
                {a.status === "COMPLETED" &&
                  (() => {
                    const payment = a.payments?.[0] ?? null;
                    return (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {payment ? (
                            <>
                              <Badge tone="green">Recebido · {paymentMethodLabel(payment.method)}</Badge>
                              <span className="text-xs text-zinc-500">{formatBRL(payment.amountCents)}</span>
                            </>
                          ) : (
                            <Badge tone="amber">Recebimento pendente</Badge>
                          )}
                        </div>
                        <Button
                          variant={payment ? "outline" : "action"}
                          disabled={busyId === a.id}
                          onClick={() =>
                            setPaymentTarget({
                              id: a.id,
                              customerName: a.customer.name,
                              serviceName: a.service.name,
                              priceCents: a.priceCents,
                              payment: payment
                                ? {
                                    id: payment.id,
                                    method: payment.method,
                                    amountCents: payment.amountCents,
                                    paidAt: payment.paidAt,
                                  }
                                : null,
                            })
                          }
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          {payment ? "Alterar recebimento" : "Registrar recebimento"}
                        </Button>
                      </div>
                    );
                  })()}
              </Card>
            );
          })}
        </div>
      )}

      <AppointmentDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setPreselectCustomerId(undefined);
        }}
        onCreated={() => load({ silent: true })}
        preselectCustomerId={preselectCustomerId}
        defaultDate={date}
      />
      <RescheduleDialog
        target={rescheduleTarget}
        onClose={() => setRescheduleTarget(null)}
        onDone={() => load({ silent: true })}
      />
      <PaymentDialog
        target={paymentTarget}
        onClose={() => setPaymentTarget(null)}
        onDone={() => void load({ silent: true })}
      />
    </div>
  );
}
