"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Badge, Select } from "@/components/ui";
import { toast } from "@/components/toast";

type Opportunity = {
  id: string;
  type: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  title: string;
  problem: string;
  evidence: string;
  suggestedAction: string;
  status: string;
  detectedAt: string;
};

const PRIORITY_TONE = { HIGH: "red", MEDIUM: "amber", LOW: "blue" } as const;
const TYPE_LABEL: Record<string, string> = {
  IDLE_SLOT: "Horário ocioso",
  RETURN_DUE: "Retorno atrasado",
  INACTIVE_CUSTOMER: "Cliente inativo",
  RISK_APPOINTMENT: "Risco de falta",
  NO_UPCOMING: "Sem agendamento futuro",
  LOW_OCCUPANCY: "Baixa ocupação",
  HIGH_DEMAND: "Alta demanda",
};

export default function OportunidadesPage() {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ pageSize: "50" });
    if (filter) params.set("type", filter);
    const res = await fetch(`/api/opportunities?${params}`);
    const data = await res.json();
    setItems(data.items ?? []);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    const res = await fetch("/api/opportunities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    });
    setRefreshing(false);
    if (!res.ok) {
      toast("Não foi possível atualizar as oportunidades.", "error");
      return;
    }
    const data = await res.json();
    toast(data.created > 0 ? `${data.created} nova(s) oportunidade(s) detectada(s).` : "Nenhuma novidade.");
    load();
  }

  async function runAction(opp: Opportunity) {
    setBusyId(opp.id);
    const isSlot = opp.type === "IDLE_SLOT";
    const res = await fetch(`/api/opportunities/${opp.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: isSlot ? "recover_slot" : "send_whatsapp" }),
    });
    setBusyId(null);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? "Não foi possível executar a ação.", "error");
      return;
    }
    toast(data.result ?? "Ação executada.");
    load();
  }

  async function dismiss(opp: Opportunity) {
    setBusyId(opp.id);
    const res = await fetch(`/api/opportunities/${opp.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DISMISSED" }),
    });
    setBusyId(null);
    if (!res.ok) {
      toast("Não foi possível descartar.", "error");
      return;
    }
    toast("Oportunidade descartada.", "info");
    load();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Oportunidades</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Situações identificadas nos seus dados — com evidência e ação recomendada.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48">
            <option value="">Todos os tipos</option>
            {Object.entries(TYPE_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Analisando..." : "🔄 Analisar agora"}
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="h-36 animate-pulse p-5">
              <div className="h-4 w-1/3 rounded bg-zinc-800" />
              <div className="mt-3 h-3 w-2/3 rounded bg-zinc-800/70" />
              <div className="mt-2 h-3 w-1/2 rounded bg-zinc-800/50" />
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="Nenhuma oportunidade aberta"
          description="O sistema analisa sua agenda, clientes e horários continuamente. Quando encontrar algo acionável, aparecerá aqui."
          action={
            <Button variant="secondary" onClick={refresh} disabled={refreshing}>
              Analisar agora
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {items.map((opp) => (
            <Card key={opp.id} className="animate-fade-up p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={PRIORITY_TONE[opp.priority]}>
                      {opp.priority === "HIGH" ? "Alta" : opp.priority === "MEDIUM" ? "Média" : "Baixa"}
                    </Badge>
                    <Badge>{TYPE_LABEL[opp.type] ?? opp.type}</Badge>
                    <span className="text-xs text-zinc-600">
                      detectada em{" "}
                      {new Date(opp.detectedAt).toLocaleDateString("pt-BR", {
                        day: "2-digit",
                        month: "2-digit",
                      })}
                    </span>
                  </div>
                  <h2 className="mt-2 font-medium text-zinc-100">{opp.title}</h2>
                  <p className="mt-1 text-sm text-zinc-400">{opp.problem}</p>
                  <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Evidência
                    </p>
                    <p className="mt-1 text-sm text-zinc-400">{opp.evidence}</p>
                    <p className="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Ação sugerida
                    </p>
                    <p className="mt-1 text-sm text-gold-300">{opp.suggestedAction}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Button
                    onClick={() => runAction(opp)}
                    disabled={busyId === opp.id}
                  >
                    {busyId === opp.id
                      ? "Enviando..."
                      : opp.type === "IDLE_SLOT"
                        ? "🕐 Recuperar horário"
                        : "💬 Enviar WhatsApp"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => dismiss(opp)}
                    disabled={busyId === opp.id}
                  >
                    Descartar
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
