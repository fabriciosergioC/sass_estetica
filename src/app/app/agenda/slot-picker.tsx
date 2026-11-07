"use client";

import { useEffect, useState } from "react";
import type { Slot } from "@/modules/scheduling/availability";

export function SlotPicker({
  barberId,
  date, // YYYY-MM-DD
  serviceId,
  durationMin,
  selected,
  onSelect,
  endpoint = "/api/availability",
}: {
  barberId: string;
  date: string;
  serviceId?: string;
  durationMin?: number;
  selected: string | null;
  onSelect: (time: string | null) => void;
  /** Ponto de consulta de horários: /api/availability (gestão) ou /api/cliente-portal/[slug]/slots (portal). */
  endpoint?: string;
}) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!barberId || !date || (!serviceId && !durationMin)) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    setSlots(null);
    setError("");
    const params = new URLSearchParams({ barberId, date, ...(serviceId ? { serviceId } : { durationMin: String(durationMin) }) });
    fetch(`${endpoint}?${params}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Erro ao buscar horários.");
        if (!cancelled) setSlots(data.slots ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [barberId, date, serviceId, endpoint]);

  if (!barberId || !date || (!serviceId && !durationMin)) {
    return <p className="text-sm text-zinc-500">Escolha serviço, atendente e data para ver os horários.</p>;
  }
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (slots === null) {
    return (
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-800/60" />
        ))}
      </div>
    );
  }
  if (slots.length === 0) {
    return <p className="text-sm text-zinc-500">O atendente não atende nesta data.</p>;
  }

  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
      {slots.map((s) => (
        <button
          key={s.start}
          type="button"
          disabled={!s.available}
          onClick={() => onSelect(selected === s.start ? null : s.start)}
          title={s.reason}
          className={`rounded-lg border px-1 py-2 text-sm font-medium transition-colors ${
            selected === s.start
              ? "border-gold-400 bg-gold-500 text-on-accent"
              : s.available
                ? "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-gold-500/60 hover:text-gold-300"
                : "cursor-not-allowed border-zinc-800/60 bg-zinc-900/40 text-zinc-600 line-through"
          }`}
        >
          {s.start}
        </button>
      ))}
    </div>
  );
}
