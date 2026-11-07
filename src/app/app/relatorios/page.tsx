"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { useTheme } from "@/components/theme";
import { formatBRL } from "@/lib/format";
import {
  PERIOD_PRESETS,
  defaultPeriod,
  fromKey,
  rangeLabel,
  shiftPeriod,
  toKey,
  type Granularity,
} from "@/lib/period";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Relatórios de faturamento com filtro de período.
 *
 * O recorte (dia / semana / mês + atalhos + setas ← →) vem de `src/lib/period.ts`, o mesmo
 * módulo que a API usa — assim a tela e o backend nunca divergem sobre o que é "este mês".
 * Todo valor chega da rota em CENTAVOS e é formatado aqui com `formatBRL`.
 */

type Bucket = {
  key: string;
  label: string;
  title: string;
  from: string;
  to: string;
  faturamentoCents: number;
  atendimentos: number;
  ticketMedioCents: number;
};

type Report = {
  granularity: Granularity;
  from: string;
  to: string;
  buckets: Bucket[];
  total: { faturamentoCents: number; atendimentos: number; ticketMedioCents: number };
  previous: {
    from: string;
    to: string;
    faturamentoCents: number;
    atendimentos: number;
    variacaoPct: number | null;
  };
};

const GRANULARITIES: { id: Granularity; label: string }[] = [
  { id: "day", label: "Por dia" },
  { id: "week", label: "Semanal" },
  { id: "month", label: "Mensal" },
];

const CUSTOM = "custom";

export default function RelatoriosPage() {
  // O recharts desenha SVG com valor literal, e atributo de apresentação não resolve `var()` de
  // CSS — por isso as cores do gráfico vêm do tema em vez das classes Tailwind.
  const { colors } = useTheme();
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [presetId, setPresetId] = useState<string>(() => defaultPeriod("month").presetId);
  const [range, setRange] = useState(() => {
    const d = defaultPeriod("month");
    return { from: toKey(d.from), to: toKey(d.to) };
  });

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = useCallback((g: Granularity, id: string) => {
    const preset = PERIOD_PRESETS[g].find((p) => p.id === id);
    if (!preset) return;
    const r = preset.range(new Date());
    setPresetId(id);
    setRange({ from: toKey(r.from), to: toKey(r.to) });
  }, []);

  const changeGranularity = useCallback(
    (g: Granularity) => {
      setGranularity(g);
      const d = defaultPeriod(g);
      setPresetId(d.presetId);
      setRange({ from: toKey(d.from), to: toKey(d.to) });
    },
    []
  );

  const move = useCallback(
    (dir: number) => {
      const next = shiftPeriod(fromKey(range.from), fromKey(range.to), granularity, dir);
      setPresetId(CUSTOM);
      setRange({ from: toKey(next.from), to: toKey(next.to) });
    },
    [granularity, range.from, range.to]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ granularity, from: range.from, to: range.to });
    fetch(`/api/reports/revenue?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "Não foi possível carregar o relatório.");
        setReport(body as Report);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Não foi possível carregar o relatório.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [granularity, range.from, range.to]);

  const from = fromKey(range.from);
  const to = fromKey(range.to);
  const periodo = rangeLabel(from, to, granularity);
  const prevPeriodo = rangeLabel(fromKey(report?.previous.from ?? range.from), fromKey(report?.previous.to ?? range.to), granularity);

  const buckets = report?.buckets ?? [];
  const variacao = report?.previous.variacaoPct ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Relatórios</h1>
          <p className="mt-1 text-sm text-zinc-500">Faturamento e atendimentos por período, com comparativo.</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
          {GRANULARITIES.map((g) => (
            <button
              key={g.id}
              onClick={() => changeGranularity(g.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                granularity === g.id ? "bg-gold-500 text-on-accent" : "text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </header>

      {/* Filtro de período */}
      <Card className="animate-fade-up space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button variant="secondary" onClick={() => move(-1)} aria-label="Período anterior">
              ←
            </Button>
            <div className="min-w-44 px-2 text-center">
              <p className="text-sm font-medium text-zinc-100">{periodo}</p>
              <p className="text-xs text-zinc-500">
                {buckets.length} {buckets.length === 1 ? "período" : "períodos"} no gráfico
              </p>
            </div>
            <Button variant="secondary" onClick={() => move(1)} aria-label="Próximo período">
              →
            </Button>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              De
              <input
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => {
                  setPresetId(CUSTOM);
                  setRange((r) => ({ ...r, from: e.target.value }));
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-gold-500 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              Até
              <input
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => {
                  setPresetId(CUSTOM);
                  setRange((r) => ({ ...r, to: e.target.value }));
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-gold-500 focus:outline-none"
              />
            </label>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 border-t border-zinc-800/60 pt-3">
          {PERIOD_PRESETS[granularity].map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(granularity, p.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                presetId === p.id
                  ? "border-gold-500/60 bg-gold-500/10 text-gold-300"
                  : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Card>

      {error && (
        <Card className="p-4">
          <p className="text-sm text-red-400">{error}</p>
        </Card>
      )}

      {loading && !report && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="animate-pulse p-5">
                <div className="h-4 w-1/3 rounded bg-zinc-800" />
                <div className="mt-3 h-8 w-1/2 rounded bg-zinc-800" />
              </Card>
            ))}
          </div>
          <Card className="animate-pulse p-5">
            <div className="h-64 rounded bg-zinc-800" />
          </Card>
        </div>
      )}

      {report && (
        <div className={`space-y-6 transition-opacity ${loading ? "opacity-60" : "opacity-100"}`}>
          {/* KPIs do período filtrado */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Card className="animate-fade-up border-gold-500/20 p-5">
              <p className="text-sm text-zinc-500">Faturamento</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-zinc-100">
                {formatBRL(report.total.faturamentoCents)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                {variacao === null ? (
                  <span>sem receita em {prevPeriodo}</span>
                ) : (
                  <Badge tone={variacao >= 0 ? "green" : "red"}>
                    {variacao >= 0 ? "▲" : "▼"} {Math.abs(variacao).toFixed(1)}% vs {prevPeriodo}
                  </Badge>
                )}
              </div>
            </Card>
            <Card className="animate-fade-up p-5">
              <p className="text-sm text-zinc-500">Atendimentos concluídos</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-zinc-100">{report.total.atendimentos}</p>
              <p className="mt-2 text-xs text-zinc-500">
                {report.previous.atendimentos} em {prevPeriodo}
              </p>
            </Card>
            <Card className="animate-fade-up p-5">
              <p className="text-sm text-zinc-500">Ticket médio</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-zinc-100">
                {formatBRL(report.total.ticketMedioCents)}
              </p>
              <p className="mt-2 text-xs text-zinc-500">por atendimento no período</p>
            </Card>
          </div>

          {buckets.length === 0 ? (
            <EmptyState
              icon="📉"
              title="Sem dados no período"
              description="Nenhum pagamento ou atendimento concluído cai dentro das datas selecionadas."
            />
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="animate-fade-up p-5">
                  <h2 className="mb-4 text-sm font-medium text-zinc-400">Evolução do faturamento</h2>
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={buckets} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorFaturamento" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={colors.accent} stopOpacity={0.25} />
                            <stop offset="95%" stopColor={colors.accent} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
                        <XAxis
                          dataKey="label"
                          stroke={colors.axis}
                          fontSize={12}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: colors.tick }}
                          interval="preserveStartEnd"
                          minTickGap={16}
                        />
                        <YAxis
                          stroke={colors.axis}
                          fontSize={12}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: colors.tick }}
                          width={70}
                          tickFormatter={(v) => axisMoney(Number(v))}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: colors.tooltipBg,
                            border: `1px solid ${colors.tooltipBorder}`,
                            borderRadius: "8px",
                          }}
                          labelStyle={{ color: colors.tooltipText }}
                          itemStyle={{ color: colors.tooltipText }}
                          formatter={(value) => [formatBRL(Number(value ?? 0)), "Faturamento"]}
                          labelFormatter={(label) => String(label)}
                        />
                        <Area
                          type="monotone"
                          dataKey="faturamentoCents"
                          stroke={colors.accent}
                          strokeWidth={2.5}
                          fill="url(#colorFaturamento)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                <Card className="animate-fade-up p-5">
                  <h2 className="mb-4 text-sm font-medium text-zinc-400">Volume de atendimentos</h2>
                  <div className="h-72 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={buckets} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
                        <XAxis
                          dataKey="label"
                          stroke={colors.axis}
                          fontSize={12}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: colors.tick }}
                          interval="preserveStartEnd"
                          minTickGap={16}
                        />
                        <YAxis
                          stroke={colors.axis}
                          fontSize={12}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: colors.tick }}
                          allowDecimals={false}
                          width={40}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: colors.tooltipBg,
                            border: `1px solid ${colors.tooltipBorder}`,
                            borderRadius: "8px",
                          }}
                          labelStyle={{ color: colors.tooltipText }}
                          itemStyle={{ color: colors.tooltipText }}
                          formatter={(value) => [String(value ?? 0), "Atendimentos"]}
                        />
                        <Bar dataKey="atendimentos" fill={colors.bar} radius={[4, 4, 0, 0]} maxBarSize={40} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              </div>

              {/* Comparativo período a período — é aqui que o mês que fecha entra na série */}
              <div className="space-y-3">
                <h2 className="text-lg font-medium text-zinc-100">Comparativo período a período</h2>
                {[...buckets].reverse().map((b, i) => {
                  const prev = buckets[buckets.length - 1 - i - 1];
                  const diff = prev && prev.faturamentoCents > 0
                    ? ((b.faturamentoCents - prev.faturamentoCents) / prev.faturamentoCents) * 100
                    : null;

                  return (
                    <Card key={b.key} className="animate-fade-up space-y-2 border-zinc-800 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                        <div>
                          <p className="text-base font-semibold text-zinc-100">{b.title}</p>
                          <p className="text-xs text-zinc-500">
                            {b.atendimentos} {b.atendimentos === 1 ? "atendimento" : "atendimentos"} · ticket médio{" "}
                            {formatBRL(b.ticketMedioCents)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xl font-bold tabular-nums text-gold-400">{formatBRL(b.faturamentoCents)}</p>
                          {diff !== null && (
                            <span
                              className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                                diff >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                              }`}
                            >
                              {diff >= 0 ? "▲" : "▼"} {Math.abs(diff).toFixed(1)}% vs {prev?.label}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-sm leading-relaxed text-zinc-400">
                        <strong className="text-zinc-200">Resumo:</strong> entre {rangeLabel(fromKey(b.from), fromKey(b.to), granularity)}{" "}
                        foram {b.atendimentos} atendimento(s) concluído(s) e {formatBRL(b.faturamentoCents)} pagos no caixa
                        {prev
                          ? ` — no período anterior (${prev.label}) foram ${prev.atendimentos} atendimento(s) e ${formatBRL(prev.faturamentoCents)}.`
                          : " — primeiro período da série selecionada, sem base anterior para comparar."}
                      </p>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Eixo Y curto: R$ 1,2k em vez de R$ 1.234,56. */
function axisMoney(cents: number): string {
  const reais = cents / 100;
  if (Math.abs(reais) >= 1000) {
    return `R$ ${(reais / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  }
  return `R$ ${reais.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
}
