"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/toast";
import { toDateInput } from "@/lib/format";
import { SlotPicker } from "./slot-picker";

type ServiceOption = { id: string; name: string; durationMin: number; priceCents: number };
type BarberOption = { id: string; name: string };

export function AppointmentDialog({
  open,
  onClose,
  onCreated,
  preselectCustomerId,
  defaultDate,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  preselectCustomerId?: string;
  defaultDate?: string;
}) {
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [barbers, setBarbers] = useState<BarberOption[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(preselectCustomerId ?? null);
  const [customerName, setCustomerName] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [barberId, setBarberId] = useState("");
  const [date, setDate] = useState(defaultDate ?? toDateInput(new Date()));
  const [time, setTime] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTime(null);
    setError("");
    setNotes("");
    fetch("/api/services?pageSize=100")
      .then((r) => r.json())
      .then((d) => setServices((d.items ?? []).filter((s: ServiceOption & { active: boolean }) => s.active)));
    fetch("/api/barbers?pageSize=100")
      .then((r) => r.json())
      .then((d) => setBarbers((d.items ?? []).filter((b: BarberOption & { active: boolean }) => b.active)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: "8" });
      if (customerQuery.trim()) params.set("q", customerQuery.trim());
      fetch(`/api/customers?${params}`)
        .then((r) => r.json())
        .then((d) => setCustomers(d.items ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [customerQuery, open]);

  const selectedService = services.find((s) => s.id === serviceId);

  async function create() {
    setError("");
    if (!customerId) return setError("Selecione o cliente.");
    if (!serviceId) return setError("Selecione o serviço.");
    if (!barberId) return setError("Selecione o atendente.");
    if (!time) return setError("Escolha um horário.");

    setSaving(true);
    const res = await fetch("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, serviceId, barberId, date, time, notes: notes.trim() || undefined }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return setError(data.error ?? "Não foi possível criar o agendamento.");
    }
    toast("Agendamento criado.");
    onCreated();
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Novo agendamento" wide>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">1. Cliente</p>
          {customerId ? (
            <div className="flex items-center justify-between rounded-lg border border-gold-500/40 bg-gold-500/5 px-3 py-2">
              <span className="text-sm font-medium text-gold-300">
                {customerName || customers.find((c) => c.id === customerId)?.name || "Cliente selecionado"}
              </span>
              <button
                className="text-xs text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setCustomerId(null);
                  setCustomerName("");
                }}
              >
                trocar
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Buscar cliente por nome ou telefone..."
                autoFocus
              />
              <div className="max-h-40 divide-y divide-zinc-800 overflow-y-auto rounded-lg border border-zinc-800">
                {customers.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-zinc-500">Nenhum cliente encontrado.</p>
                ) : (
                  customers.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-800/60"
                      onClick={() => {
                        setCustomerId(c.id);
                        setCustomerName(c.name);
                      }}
                    >
                      <span>{c.name}</span>
                      <span className="text-xs text-zinc-500">{c.phone}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="2. Serviço">
            <Select
              value={serviceId}
              onChange={(e) => {
                setServiceId(e.target.value);
                setTime(null);
              }}
            >
              <option value="">Selecione...</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMin}min
                </option>
              ))}
            </Select>
          </Field>
          <Field label="3. Atendente">
            <Select
              value={barberId}
              onChange={(e) => {
                setBarberId(e.target.value);
                setTime(null);
              }}
            >
              <option value="">Selecione...</option>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="4. Data">
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setTime(null);
            }}
          />
        </Field>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
            5. Horário{selectedService ? ` · duração ${selectedService.durationMin}min` : ""}
          </p>
          <SlotPicker barberId={barberId} date={date} serviceId={serviceId} selected={time} onSelect={setTime} />
        </div>

        <Field label="Observações">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" className="min-h-12" />
        </Field>

        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={create} disabled={saving}>
            {saving ? "Agendando..." : "Confirmar agendamento"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
