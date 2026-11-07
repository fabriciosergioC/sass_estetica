"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/dialog";
import { Button, Field, Input, Select } from "@/components/ui";
import { toast } from "@/components/toast";
import { formatTimeHHMM, toDateInput } from "@/lib/format";
import { SlotPicker } from "./slot-picker";

type BarberOption = { id: string; name: string };

export type RescheduleTarget = {
  id: string;
  label: string;
  barberId: string;
  startAt: string;
  durationMin: number;
};

export function RescheduleDialog({
  target,
  onClose,
  onDone,
}: {
  target: RescheduleTarget | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [barbers, setBarbers] = useState<BarberOption[]>([]);
  const [barberId, setBarberId] = useState("");
  const [date, setDate] = useState(toDateInput(new Date()));
  const [time, setTime] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!target) return;
    setBarberId(target.barberId);
    const d = new Date(target.startAt);
    setDate(toDateInput(d));
    setTime(null);
    setError("");
    fetch("/api/barbers?pageSize=100")
      .then((r) => r.json())
      .then((data) => setBarbers((data.items ?? []).filter((b: BarberOption & { active: boolean }) => b.active)));
  }, [target]);

  async function save() {
    if (!target || !time) return;
    setError("");
    setSaving(true);
    const res = await fetch(`/api/appointments/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, time, barberId: barberId || undefined }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return setError(data.error ?? "Não foi possível remarcar.");
    }
    toast(`Reagendado para ${date} às ${time}.`);
    onDone();
    onClose();
  }

  return (
    <Dialog open={!!target} onClose={onClose} title="Reagendar" wide>
      {target && (
        <div className="space-y-4">
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-400">
            {target.label} · atualmente {new Date(target.startAt).toLocaleDateString("pt-BR")} às{" "}
            {formatTimeHHMM(target.startAt)}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Atendente">
              <Select
                value={barberId}
                onChange={(e) => {
                  setBarberId(e.target.value);
                  setTime(null);
                }}
              >
                {barbers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Nova data">
              <Input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setTime(null);
                }}
              />
            </Field>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
              Novo horário · duração {target.durationMin}min
            </p>
            <SlotPicker barberId={barberId} date={date} durationMin={target.durationMin} selected={time} onSelect={setTime} />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving || !time}>
              {saving ? "Remarcando..." : "Confirmar novo horário"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
