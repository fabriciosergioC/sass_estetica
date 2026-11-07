"use client";

import Link from "next/link";
import { useDashboard } from "@/lib/hooks";
import { Card, Badge } from "@/components/ui";
import { STATUS_META } from "@/lib/format";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

function brl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function DashboardPage() {
  const { data, isLoading, error } = useDashboard();

  if (error) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Card className="border-red-500/30 bg-red-500/5 p-5">
          <p className="text-red-400">Erro ao carregar dados. Tente recarregar a página.</p>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-800" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-800/50" />
          ))}
        </div>
      </div>
    );
  }

  // O fetcher do `useApi` devolve o corpo de qualquer resposta, inclusive de um 500 (`{error}`), então
  // `data` pode existir sem nenhum dos campos. Sem essa guarda a página morria em
  // "Cannot read properties of undefined (reading 'map')" — o card de erro abaixo é o caminho certo.
  const semCampos =
    !data.org ||
    !Array.isArray(data.statusGroups) ||
    !Array.isArray(data.serviceNames) ||
    !Array.isArray(data.barberNames) ||
    !data.kpis;
  if (semCampos) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Card className="border-red-500/30 bg-red-500/5 p-5">
          <p className="text-red-400">Erro ao carregar dados. Tente recarregar a página.</p>
          <p className="mt-1 text-xs text-zinc-400">
            O servidor respondeu sem os dados do painel. <code>npm run dev</code> mostra o motivo.
          </p>
        </Card>
      </div>
    );
  }

  const statusCount = (s: string) => data.statusGroups.find((g) => g.status === s)?.count ?? 0;

  const serviceMap = new Map(data.serviceNames.map((s) => [s.id, s.name]));
  const barberMap = new Map(data.barberNames.map((b) => [b.id, b.name]));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting()}, {data.userName}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {data.org.name}
          </p>
        </div>
      </header>

      {data.pending.length > 0 && (
        <Card className="animate-fade-up border-gold-500/30 bg-gold-500/5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium text-gold-300">Complete o cadastro da sua clínica</h2>
              <p className="mt-0.5 text-sm text-zinc-400">
                Falta pouco: complete {data.pending.length} {data.pending.length === 1 ? "etapa" : "etapas"} para
                começar.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {data.pending.map((c) => (
                <Link
                  key={c.label}
                  href={c.href}
                  className="rounded-lg bg-gold-500 px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-gold-400"
                >
                  {c.label}
                </Link>
              ))}
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="animate-fade-up p-4">
          <p className="text-2xl font-semibold tabular-nums text-gold-400">{brl(data.kpis.revenue)}</p>
          <p className="mt-1 text-xs text-zinc-500">Faturamento (30d)</p>
        </Card>
        <Card className="animate-fade-up p-4">
          <p className="text-2xl font-semibold tabular-nums">{data.kpis.completed}</p>
          <p className="mt-1 text-xs text-zinc-500">Concluídos</p>
        </Card>
        <Card className="animate-fade-up p-4">
          <p className="text-2xl font-semibold tabular-nums">{brl(data.kpis.ticket)}</p>
          <p className="mt-1 text-xs text-zinc-500">Ticket médio</p>
        </Card>
        <Card className="animate-fade-up p-4">
          <p className="text-2xl font-semibold tabular-nums">{data.kpis.newCustomers}</p>
          <p className="mt-1 text-xs text-zinc-500">Novos clientes</p>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="animate-fade-up p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Status dos agendamentos (30d)</h2>
            <Badge tone={data.noShowRate > 15 ? "red" : data.noShowRate > 8 ? "amber" : "green"}>
              faltas {data.noShowRate}%
            </Badge>
          </div>
          <div className="mt-4 space-y-2">
            {(["SCHEDULED", "CONFIRMED", "IN_SERVICE", "COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"] as const).map((s) => {
              const meta = STATUS_META[s];
              const count = statusCount(s);
              const total = data.statusGroups.reduce((a, g) => a + g.count, 0);
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={s} className="flex items-center gap-3">
                  <span className="w-24 text-xs text-zinc-500">{meta.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                    <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${Math.max(pct, count > 0 ? 3 : 0)}%` }} />
                  </div>
                  <span className="w-8 text-right text-xs tabular-nums text-zinc-400">{count}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="animate-fade-up p-5">
          <h2 className="font-medium">Próximos horários hoje</h2>
          {data.upcoming.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Nenhum agendamento pendente para o resta do dia.</p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-800/60">
              {data.upcoming.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="tabular-nums text-zinc-400">
                    {new Date(a.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="flex-1 px-3">{a.customerName}</span>
                  <Badge tone={a.status === "CONFIRMED" ? "gold" : "blue"}>{STATUS_META[a.status as keyof typeof STATUS_META].label}</Badge>
                  <span className="hidden w-28 text-right text-xs text-zinc-500 sm:block">{a.barberName}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2 border-t border-zinc-800/60 pt-3 text-xs text-zinc-500">
            <span>Hoje: <strong className="text-zinc-300">{data.kpis.todayAppointments}</strong> agend.</span>
            <span>·</span>
            <span>Cancelados: <strong className="text-zinc-300">{data.cancelled}</strong></span>
            <span>·</span>
            <span>Oportunidades: <strong className="text-zinc-300">{data.kpis.openOpportunities}</strong></span>
          </div>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="animate-fade-up p-5">
          <h2 className="font-medium">Serviços mais realizados (30d)</h2>
          {data.topServices.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Sem atendimentos concluídos no período.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.topServices.map((s, i) => (
                <li key={s.serviceId} className="flex items-center gap-3 text-sm">
                  <span className="w-5 text-right text-xs text-zinc-600">{i + 1}.</span>
                  <span className="flex-1">{serviceMap.get(s.serviceId) ?? "—"}</span>
                  <span className="text-xs tabular-nums text-zinc-500">{s.count}x</span>
                  <span className="w-20 text-right text-xs tabular-nums text-gold-400">{brl(s.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="animate-fade-up p-5">
          <h2 className="font-medium">Desempenho da equipe (30d)</h2>
          {data.topBarbers.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">Sem atendimentos concluídos no período.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.topBarbers.map((b, i) => (
                <li key={b.barberId} className="flex items-center gap-3 text-sm">
                  <span className="w-5 text-right text-xs text-zinc-600">{i + 1}.</span>
                  <span className="flex-1">{barberMap.get(b.barberId) ?? "—"}</span>
                  <span className="text-xs tabular-nums text-zinc-500">{b.count}x</span>
                  <span className="w-20 text-right text-xs tabular-nums text-gold-400">{brl(b.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {(data.topOpportunities.length > 0 || data.returnDue > 0) && (
        <Card className="animate-fade-up border-gold-500/20 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-medium">🧭 Central de Inteligência</h2>
              <p className="text-xs text-zinc-500">O que merece atenção — e o que fazer agora.</p>
            </div>
            <Link href="/app/oportunidades" className="text-xs font-medium text-gold-400 hover:text-gold-300">
              ver todas →
            </Link>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-sm text-zinc-400">
            <span>
              <strong className="text-zinc-200">{data.kpis.todayAppointments}</strong> agendamentos hoje
            </span>
            <span className="text-zinc-700">·</span>
            <span>
              <strong className="text-zinc-200">{data.returnDue}</strong> clientes atrasados para retornar
            </span>
            <span className="text-zinc-700">·</span>
            <span>
              <strong className="text-zinc-200">{data.riskAppts}</strong> agendamentos em risco de falta (7d)
            </span>
          </div>

          {data.topOpportunities.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {data.topOpportunities.map((op) => (
                <li
                  key={op.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-200">{op.title}</p>
                    <p className="truncate text-xs text-zinc-500">{op.suggestedAction}</p>
                  </div>
                  <Badge tone={op.priority === "HIGH" ? "red" : op.priority === "MEDIUM" ? "amber" : "blue"}>
                    {op.type.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              Nenhuma oportunidade aberta. Tudo em ordem por aqui. ✅
            </p>
          )}
        </Card>
      )}

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Status da plataforma</h2>
          <Badge tone={data.org.status === "ACTIVE" ? "green" : "amber"}>
            {data.org.status === "ACTIVE" ? "Operando" : data.org.status}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-zinc-500">
          {data.customers} clientes cadastrados · {data.barbers} atendentes ativos · {data.services} serviços ativos ·
          link público: <span className="text-zinc-300">/b/{data.org.slug}</span>
        </p>
      </Card>
    </div>
  );
}
