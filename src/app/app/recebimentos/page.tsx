"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, Select } from "@/components/ui";
import { Dialog } from "@/components/dialog";
import { toast } from "@/components/toast";
import { formatBRL, parseBRLToCents } from "@/lib/format";
import { formatBusinessTime } from "@/lib/datetime";
import { toKey } from "@/lib/period";
import { PAYMENT_METHODS, paymentMethodLabel, type PaymentMethod } from "@/lib/payment-methods";

/**
 * Recebimentos do caixa por forma de pagamento.
 *
 * - Os cartões do topo somam TODAS as formas do período (o filtro de forma muda só a lista).
 * - "Novo recebimento" registra um valor manual, vinculado a um atendimento ou avulso.
 * - Concluir um atendimento já cria o recebimento como Dinheiro; o "Editar" corrige a forma
 *   quando o cliente pagou em PIX/cartão, sem duplicar o lançamento.
 */

type Receipt = {
  id: string;
  amountCents: number;
  method: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  appointment: {
    id: string;
    startAt: string;
    customer: { id: string; name: string; phone: string | null } | null;
    service: { name: string } | null;
    barber: { name: string } | null;
  } | null;
};

type Totals = {
  totalCents: number;
  count: number;
  byMethod: Record<string, { cents: number; count: number }>;
  pendingCents: number;
  pendingCount: number;
};

/** Atendimento concluído sem lançamento no caixa — ainda não é dinheiro recebido. */
type PendingReceipt = {
  appointmentId: string;
  amountCents: number;
  startAt: string;
  customer: { id: string; name: string; phone: string | null } | null;
  service: { name: string } | null;
  barber: { name: string } | null;
};

type PaymentsResponse = {
  from: string;
  to: string;
  items: Receipt[];
  pending: PendingReceipt[];
  totals: Totals;
};

type AppointmentOption = {
  id: string;
  startAt: string;
  status: string;
  priceCents: number;
  customer: { name: string } | null;
  service: { name: string } | null;
};

const METHOD_TONE: Record<string, "green" | "gold" | "blue" | "neutral"> = {
  CASH: "green",
  PIX: "gold",
  CARD: "blue",
  OTHER: "neutral",
};

const todayKey = () => toKey(new Date());
const monthStartKey = () => {
  const now = new Date();
  return toKey(new Date(now.getFullYear(), now.getMonth(), 1));
};

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function appointmentOptionLabel(appointment: AppointmentOption): string {
  const at = new Date(appointment.startAt);
  return `${at.toLocaleDateString("pt-BR")} ${formatBusinessTime(at)} · ${
    appointment.customer?.name ?? "Cliente"
  }${appointment.service ? ` · ${appointment.service.name}` : ""}`;
}

/** Data digitada → instante do recebimento: hoje mantém a hora real; dia passado usa 12:00. */
function paidAtFor(dateKey: string): string {
  if (dateKey === todayKey()) return new Date().toISOString();
  return new Date(`${dateKey}T12:00:00-03:00`).toISOString();
}

export default function RecebimentosPage() {
  const [range, setRange] = useState(() => ({ from: monthStartKey(), to: todayKey() }));
  const [methodFilter, setMethodFilter] = useState("");
  const [data, setData] = useState<PaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; receipt: Receipt } | null>(null);
  const [draft, setDraft] = useState({
    appointmentId: "",
    amount: "",
    method: "CASH" as PaymentMethod,
    date: todayKey(),
  });
  const [formErrors, setFormErrors] = useState<{ amount?: string; date?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);
  const [appointments, setAppointments] = useState<AppointmentOption[]>([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  // Atendimento pendente escolhido na lista: pode estar fora da janela de 30 dias do seletor,
  // então guardamos ele aqui para o campo mostrar o cliente certo em vez de "Avulso".
  const [seedAppointment, setSeedAppointment] = useState<AppointmentOption | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (methodFilter) params.set("method", methodFilter);
    try {
      const res = await fetch(`/api/payments?${params}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "Não foi possível carregar os recebimentos.");
      setData(body as PaymentsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar os recebimentos.");
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, methodFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Atendimentos recentes (30 dias para trás, 7 para frente) para vincular um recebimento.
  // Carregados só quando o diálogo de novo lançamento abre.
  useEffect(() => {
    if (!dialog || dialog.mode === "edit") return;
    let cancelled = false;
    setAppointmentsLoading(true);
    const now = new Date();
    const from = toKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
    const to = toKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
    fetch(`/api/appointments?from=${from}&to=${to}`)
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        const items = (body.items ?? []) as AppointmentOption[];
        setAppointments(items.filter((item) => !["CANCELLED", "RESCHEDULED"].includes(item.status)));
      })
      .catch(() => {
        if (!cancelled) setAppointments([]);
      })
      .finally(() => {
        if (!cancelled) setAppointmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dialog]);

  function applyPreset(preset: "today" | "month" | "lastMonth") {
    const now = new Date();
    if (preset === "today") {
      setRange({ from: toKey(now), to: toKey(now) });
      return;
    }
    if (preset === "month") {
      setRange({ from: toKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: toKey(now) });
      return;
    }
    setRange({
      from: toKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: toKey(new Date(now.getFullYear(), now.getMonth(), 0)),
    });
  }

  function openCreate() {
    setFormErrors({});
    setSeedAppointment(null);
    setDraft({ appointmentId: "", amount: "", method: "CASH", date: todayKey() });
    setDialog({ mode: "create" });
  }

  /** "Registrar" de um atendimento pendente: já abre vinculado, com o valor do serviço. */
  function openCreateForPending(pending: PendingReceipt) {
    setFormErrors({});
    const appointmentDay = toKey(new Date(pending.startAt));
    setSeedAppointment({
      id: pending.appointmentId,
      startAt: pending.startAt,
      status: "COMPLETED",
      priceCents: pending.amountCents,
      customer: pending.customer ? { name: pending.customer.name } : null,
      service: pending.service,
    });
    setDraft({
      appointmentId: pending.appointmentId,
      amount: centsToInput(pending.amountCents),
      method: "CASH",
      // Recebimento não pode ser datado no futuro; atendimento adiantado cai em hoje.
      date: appointmentDay > todayKey() ? todayKey() : appointmentDay,
    });
    setDialog({ mode: "create" });
  }

  function openEdit(receipt: Receipt) {
    setFormErrors({});
    setDraft({
      appointmentId: receipt.appointment?.id ?? "",
      amount: centsToInput(receipt.amountCents),
      method: (receipt.method as PaymentMethod) ?? "CASH",
      date: receipt.paidAt ? toKey(new Date(receipt.paidAt)) : todayKey(),
    });
    setDialog({ mode: "edit", receipt });
  }

  function chooseAppointment(id: string) {
    const option = appointments.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      appointmentId: id,
      // Sugere o valor do atendimento; o operador pode ajustar (desconto, gorjeta).
      amount: option ? centsToInput(option.priceCents) : current.amount,
    }));
  }

  async function submit() {
    const errors: typeof formErrors = {};
    const cents = parseBRLToCents(draft.amount);
    if (!draft.amount.trim() || Number.isNaN(cents) || cents <= 0) {
      errors.amount = "Informe um valor válido (ex: 120,00).";
    }
    if (!draft.date) errors.date = "Informe a data do recebimento.";
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    setSaving(true);
    setFormErrors({});
    try {
      const isEdit = dialog?.mode === "edit";
      const res = await fetch(isEdit ? `/api/payments/${dialog.receipt.id}` : "/api/payments", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEdit ? {} : { appointmentId: draft.appointmentId || null }),
          amountCents: cents,
          method: draft.method,
          paidAt: paidAtFor(draft.date),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormErrors({ form: typeof body.error === "string" ? body.error : "Não foi possível salvar o recebimento." });
        return;
      }
      toast(isEdit ? "Recebimento atualizado." : "Recebimento registrado.");
      setDialog(null);
      await load();
    } catch {
      setFormErrors({ form: "Não foi possível salvar o recebimento. Tente novamente." });
    } finally {
      setSaving(false);
    }
  }

  const totals = data?.totals;
  const items = data?.items ?? [];
  const pending = data?.pending ?? [];
  const isEditing = dialog?.mode === "edit";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recebimentos</h1>
          <p className="mt-1 text-sm text-zinc-500">
            O que entrou no caixa por forma de pagamento. Atendimentos concluídos sem lançamento
            aparecem como pendentes até você registrar a forma aqui ou pelo botão na própria Agenda.
          </p>
        </div>
        <Button onClick={openCreate}>＋ Novo recebimento</Button>
      </header>

      {/* Filtro de período e forma */}
      <Card className="animate-fade-up space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            De
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((current) => ({ ...current, from: e.target.value }))}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-gold-500 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            Até
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => setRange((current) => ({ ...current, to: e.target.value }))}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-gold-500 focus:outline-none"
            />
          </label>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: "today", label: "Hoje" },
                { id: "month", label: "Este mês" },
                { id: "lastMonth", label: "Mês passado" },
              ] as const
            ).map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset.id)}
                className="rounded-full border border-zinc-800 px-3 py-1 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              >
                {preset.label}
              </button>
            ))}
            <Select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
              className="w-40"
              aria-label="Filtrar por forma de pagamento"
            >
              <option value="">Todas as formas</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      {/* Totais por forma */}
      <div className="space-y-3">
        <Card className="flex flex-wrap items-center justify-between gap-3 border-gold-500/30 bg-gold-500/[0.06] p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Total recebido no período</p>
            <p className="mt-1 text-3xl font-semibold text-gold-300">{formatBRL(totals?.totalCents ?? 0)}</p>
            {pending.length > 0 && (
              <p className="mt-1 text-xs text-amber-300">
                + {formatBRL(totals?.pendingCents ?? 0)} aguardando recebimento ({pending.length} atendimento(s))
              </p>
            )}
          </div>
          <Badge tone="gold">{totals?.count ?? 0} lançamento(s)</Badge>
        </Card>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PAYMENT_METHODS.map((method) => (
            <Card key={method.id} className="p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                <span aria-hidden>{method.icon}</span>
                {method.label}
              </p>
              <p className="mt-1.5 text-lg font-semibold text-zinc-100">
                {formatBRL(totals?.byMethod[method.id]?.cents ?? 0)}
              </p>
              <p className="text-xs text-zinc-500">{totals?.byMethod[method.id]?.count ?? 0} lançamento(s)</p>
            </Card>
          ))}
        </div>
      </div>

      {/* Lançamentos */}
      {error ? (
        <Card className="border-red-500/30 bg-red-500/[0.06] p-4 text-sm text-red-300">{error}</Card>
      ) : loading ? (
        <Card className="animate-pulse p-6">
          <div className="h-4 w-1/3 rounded bg-zinc-800" />
          <div className="mt-3 h-3 w-2/3 rounded bg-zinc-800/70" />
        </Card>
      ) : (
        <>
          {/* Concluídos sem lançamento: aparecem aqui para o operador registrar, mas não
              somam no total — enquanto não há forma e valor, não é dinheiro no caixa. */}
          {pending.length > 0 && (
            <Card className="border-amber-500/30 bg-amber-500/[0.04]">
              <div className="border-b border-zinc-800/60 px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-medium">Aguardando recebimento</h2>
                  <Badge tone="amber">{pending.length} pendente(s)</Badge>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Atendimentos concluídos sem lançamento no caixa — não somam no total recebido e
                  continuam aqui até você registrar a forma.
                </p>
              </div>
              <ul className="divide-y divide-zinc-800/60">
                {pending.map((item) => {
                  const at = new Date(item.startAt);
                  return (
                    <li key={item.appointmentId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                          {item.customer?.name ?? "Cliente"}
                          <Badge tone="amber">Pendente</Badge>
                        </p>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {at.toLocaleDateString("pt-BR")} às {formatBusinessTime(at)}
                          {item.service ? ` · ${item.service.name}` : ""}
                          {item.barber ? ` · ${item.barber.name}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-amber-300">{formatBRL(item.amountCents)}</span>
                        <Button variant="action" onClick={() => openCreateForPending(item)}>
                          Registrar
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {items.length === 0 ? (
            pending.length === 0 ? (
              <EmptyState
                icon="💰"
                title="Nenhum recebimento no período"
                description="Registre um recebimento manual ou ajuste as datas para ver o que já entrou no caixa."
                action={<Button variant="secondary" onClick={openCreate}>Registrar recebimento</Button>}
              />
            ) : (
              <Card className="p-5 text-sm text-zinc-500">
                Nenhum recebimento registrado no período. Os atendimentos pendentes acima viram
                lançamento quando você informar valor e forma de pagamento.
              </Card>
            )
          ) : (
        <Card>
          <div className="flex items-center justify-between border-b border-zinc-800/60 px-5 py-3">
            <h2 className="font-medium">Lançamentos</h2>
            <span className="text-xs text-zinc-500">{items.length} no filtro</span>
          </div>
          <ul className="divide-y divide-zinc-800/60">
            {items.map((receipt) => {
              const paidAt = receipt.paidAt ? new Date(receipt.paidAt) : null;
              const customerName = receipt.appointment?.customer?.name ?? "Avulso";
              const serviceName = receipt.appointment?.service?.name;
              const barberName = receipt.appointment?.barber?.name;
              return (
                <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                      {customerName}
                      <Badge tone={METHOD_TONE[receipt.method] ?? "neutral"}>
                        {paymentMethodLabel(receipt.method)}
                      </Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {paidAt
                        ? `${paidAt.toLocaleDateString("pt-BR")} às ${formatBusinessTime(paidAt)}`
                        : "Sem data"}
                      {serviceName ? ` · ${serviceName}` : " · Recebimento sem atendimento"}
                      {barberName ? ` · ${barberName}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-zinc-100">{formatBRL(receipt.amountCents)}</span>
                    <Button variant="ghost" onClick={() => openEdit(receipt)}>
                      Editar
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
          )}
        </>
      )}

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={isEditing ? "Editar recebimento" : "Novo recebimento"}
      >
        <div className="space-y-3">
          {!isEditing && (
            <Field
              label="Atendimento (opcional)"
              hint="Sem vínculo = recebimento avulso (produto, gorjeta, taxa)."
            >
              <Select
                value={draft.appointmentId}
                onChange={(e) => chooseAppointment(e.target.value)}
                disabled={appointmentsLoading}
              >
                <option value="">{appointmentsLoading ? "Carregando atendimentos..." : "Sem atendimento (avulso)"}</option>
                {seedAppointment && !appointments.some((item) => item.id === seedAppointment.id) && (
                  <option value={seedAppointment.id}>{appointmentOptionLabel(seedAppointment)}</option>
                )}
                {appointments.map((appointment) => (
                  <option key={appointment.id} value={appointment.id}>
                    {appointmentOptionLabel(appointment)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {isEditing && dialog.mode === "edit" && (
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-400">
              {dialog.receipt.appointment
                ? `Atendimento de ${dialog.receipt.appointment.customer?.name ?? "cliente"}${
                    dialog.receipt.appointment.service ? ` · ${dialog.receipt.appointment.service.name}` : ""
                  }`
                : "Recebimento avulso, sem atendimento vinculado."}
            </p>
          )}

          <Field label="Valor (R$)" error={formErrors.amount}>
            <Input
              inputMode="decimal"
              placeholder="0,00"
              value={draft.amount}
              onChange={(e) => setDraft((current) => ({ ...current, amount: e.target.value }))}
            />
          </Field>

          <Field label="Forma de pagamento">
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_METHODS.map((method) => {
                const active = draft.method === method.id;
                return (
                  <button
                    key={method.id}
                    type="button"
                    onClick={() => setDraft((current) => ({ ...current, method: method.id }))}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "border-gold-500/60 bg-gold-500/10 text-gold-300"
                        : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                    aria-pressed={active}
                  >
                    <span aria-hidden>{method.icon}</span>
                    {method.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Data do recebimento" error={formErrors.date}>
            <Input
              type="date"
              value={draft.date}
              max={todayKey()}
              onChange={(e) => setDraft((current) => ({ ...current, date: e.target.value }))}
            />
          </Field>

          {formErrors.form && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-sm text-red-300">
              {formErrors.form}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? "Salvando..." : isEditing ? "Salvar alterações" : "Registrar recebimento"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}