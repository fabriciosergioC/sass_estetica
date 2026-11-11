"use client";

import { useEffect, useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { Dialog } from "@/components/dialog";
import { toast } from "@/components/toast";
import { parseBRLToCents } from "@/lib/format";
import { toKey } from "@/lib/period";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/payment-methods";

/**
 * Status do recebimento de um atendimento concluído, direto na Agenda.
 *
 * Concluir um atendimento não cria mais pagamento automático: é aqui que o operador diz se
 * já recebeu, quanto e por qual forma. Se o atendimento já tem recebimento, o diálogo abre em
 * modo de edição (PATCH) — corrigir a forma de um lançamento não duplica o caixa.
 */

export type PaymentTarget = {
  id: string;
  customerName: string;
  serviceName: string;
  priceCents: number;
  payment?: { id: string; method: string; amountCents: number; paidAt: string | null } | null;
};

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

const todayKey = () => toKey(new Date());

/** Hoje mantém a hora real; dia passado usa 12:00 para não escorregar de dia no fuso. */
function paidAtFor(dateKey: string): string {
  if (dateKey === todayKey()) return new Date().toISOString();
  return new Date(`${dateKey}T12:00:00-03:00`).toISOString();
}

export function PaymentDialog({
  target,
  onClose,
  onDone,
}: {
  target: PaymentTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [date, setDate] = useState(todayKey());
  const [errors, setErrors] = useState<{ amount?: string; date?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  // Cada abertura recomeça do atendimento escolhido — nunca herda o rascunho do anterior.
  useEffect(() => {
    if (!target) return;
    setAmount(centsToInput(target.payment?.amountCents ?? target.priceCents));
    setMethod((target.payment?.method as PaymentMethod) ?? "CASH");
    setDate(target.payment?.paidAt ? toKey(new Date(target.payment.paidAt)) : todayKey());
    setErrors({});
  }, [target]);

  async function submit() {
    if (!target) return;
    const nextErrors: typeof errors = {};
    const cents = parseBRLToCents(amount);
    if (!amount.trim() || Number.isNaN(cents) || cents <= 0) {
      nextErrors.amount = "Informe um valor válido (ex: 120,00).";
    }
    if (!date) nextErrors.date = "Informe a data do recebimento.";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSaving(true);
    setErrors({});
    try {
      const existing = target.payment;
      const res = await fetch(existing ? `/api/payments/${existing.id}` : "/api/payments", {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(existing ? {} : { appointmentId: target.id }),
          amountCents: cents,
          method,
          paidAt: paidAtFor(date),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors({ form: typeof body.error === "string" ? body.error : "Não foi possível salvar o recebimento." });
        return;
      }
      toast(existing ? "Recebimento atualizado." : "Recebimento registrado.");
      onDone();
      onClose();
    } catch {
      setErrors({ form: "Não foi possível salvar o recebimento. Tente novamente." });
    } finally {
      setSaving(false);
    }
  }

  const editing = Boolean(target?.payment);

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={editing ? "Recebimento do atendimento" : "Registrar recebimento"}
    >
      {target && (
        <div className="space-y-3">
          <p className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-400">
            {target.customerName}
            {target.serviceName ? ` · ${target.serviceName}` : ""}
          </p>

          <Field label="Valor (R$)" error={errors.amount}>
            <Input
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>

          <Field label="Forma de pagamento">
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_METHODS.map((option) => {
                const active = method === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setMethod(option.id)}
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "border-gold-500/60 bg-gold-500/10 text-gold-300"
                        : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                    }`}
                  >
                    <span aria-hidden>{option.icon}</span>
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Data do recebimento" error={errors.date}>
            <Input
              type="date"
              value={date}
              max={todayKey()}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>

          {errors.form && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-sm text-red-300">
              {errors.form}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? "Salvando..." : editing ? "Salvar recebimento" : "Registrar recebimento"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}