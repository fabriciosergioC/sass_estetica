"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@/components/ui";
import { toast } from "@/components/toast";
import { phoneLabel } from "@/lib/whatsapp-labels";

/**
 * Painel "Fila travada" (§26).
 *
 * A tela de conversas mostra "Na fila", mas não diz POR QUE a mensagem não saiu. Aqui o
 * diagnóstico é separado por causa — sem job, job morto, job vencido, agendada, em execução
 * ou erro — e o reenvio é feito pelo mesmo caminho da fila, com espaçamento. É o que evita
 * duplicar mensagem e tomar bloqueio por disparo em rajada.
 */

type Situation = "stuck" | "waiting" | "scheduled" | "running" | "failed";

type JobInfo = {
  id: string;
  status: string;
  runAt: string;
  lastError: string | null;
  attempts: number;
};

type StuckItem = {
  id: string;
  status: string;
  phone: string;
  contactName: string | null;
  customerName: string | null;
  preview: string;
  templateKey: string | null;
  createdAt: string;
  error: string | null;
  situation: Situation;
  retryable: boolean;
  note: string | null;
  job: JobInfo | null;
};

type DeadJob = {
  id: string;
  type: string;
  messageId: string | null;
  messageStatus: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  retryable: boolean;
  note: string | null;
};

type ProcessingJob = {
  id: string;
  type: string;
  messageId: string | null;
  runAt: string;
  attempts: number;
  createdAt: string;
};

type Snapshot = {
  pause: { paused: boolean; until: string | null; reason: string | null };
  limits: { intervalMs: number; perHour: number; pauseAfterFailures: number; pauseMinutes: number };
  counts: {
    queued: number;
    stuck: number;
    waiting: number;
    scheduled: number;
    running: number;
    failed: number;
    deadJobs: number;
    processing: number;
  };
  queued: StuckItem[];
  failed: StuckItem[];
  deadJobs: DeadJob[];
  processing: ProcessingJob[];
  truncated: { queued: boolean; failed: boolean };
};

type ActionResult = {
  scanned?: number;
  retried?: number;
  revived?: number;
  skipped?: number;
  requeued?: number;
  errors?: { id: string; error: string }[];
  paused?: boolean;
};

const SITUATION: Record<Situation, { label: string; tone: "red" | "amber" | "neutral" | "blue" }> = {
  stuck: { label: "travada", tone: "red" },
  waiting: { label: "aguardando", tone: "amber" },
  scheduled: { label: "agendada", tone: "neutral" },
  running: { label: "enviando", tone: "blue" },
  failed: { label: "erro", tone: "red" },
};

function who(item: StuckItem) {
  return item.customerName ?? item.contactName ?? phoneLabel(item.phone);
}

function since(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "agora";
  if (ms < 60_000) return "agora";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.floor(hours / 24)} d`;
}

export function StuckQueuePanel() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);

  const load = useCallback(async (opts: { silent?: boolean; quiet?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const res = await fetch("/api/whatsapp/queue/stuck", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (!opts.quiet) toast(json.error ?? "Não foi possível ler a fila travada.", "error");
        return;
      }
      const snapshot = json as Snapshot;
      setData(snapshot);

      const retryable = new Set<string>();
      for (const item of [...snapshot.queued, ...snapshot.failed]) {
        if (item.retryable) retryable.add(item.id);
      }
      const revivable = new Set<string>();
      for (const job of snapshot.deadJobs) {
        if (job.retryable) revivable.add(job.id);
      }
      setSelected((prev) => prev.filter((id) => retryable.has(id)));
      setSelectedJobs((prev) => prev.filter((id) => revivable.has(id)));
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const res = await fetch("/api/whatsapp/queue/stuck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(json.error ?? "Não foi possível concluir.", "error");
        return null;
      }
      if (json.snapshot) setData(json.snapshot as Snapshot);
      return json as { result: ActionResult; snapshot: Snapshot };
    } finally {
      setBusy(null);
    }
  }

  async function resumeQueue() {
    setBusy("resume");
    try {
      const res = await fetch("/api/whatsapp/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(json.error ?? "Não foi possível retomar os envios.", "error");
        return;
      }
      toast("Envios retomados. Agora o reenvio pode ser feito.");
      await load({ silent: true });
    } finally {
      setBusy(null);
    }
  }

  function reportRetry(result: ActionResult) {
    if (result.paused) {
      toast("A fila está pausada. Retome os envios antes de reenviar.", "error");
      return;
    }
    const parts = [`${result.retried ?? 0} reenviada(s) para a fila`];
    if (result.skipped) parts.push(`${result.skipped} ignorada(s)`);
    if (result.errors?.length) parts.push(`${result.errors.length} falha(s)`);
    toast(parts.join(" · "), result.errors?.length ? "error" : "success");
  }

  async function retrySelected() {
    if (!selected.length) return;
    const seconds = Math.max(1, Math.round((data?.limits.intervalMs ?? 3_000) / 1_000));
    const ok = confirm(
      `Reenviar ${selected.length} mensagem(ns)?\n\n` +
        `O envio volta pela fila, espaçado a cada ${seconds}s, e respeita pausa, limite de ` +
        `${data?.limits.perHour ?? 60}/hora, número bloqueado e opt-out. A mesma mensagem não é ` +
        `duplicada e lembretes agendados para o futuro não são antecipados.`
    );
    if (!ok) return;

    const json = await post("retry", { ids: selected });
    if (!json) return;
    setSelected([]);
    reportRetry(json.result);
  }

  async function retryAll(scope: "queued" | "failed") {
    const count = scope === "queued" ? data?.counts.stuck ?? 0 : data?.counts.failed ?? 0;
    if (!count) {
      toast("Nada para reenviar neste grupo.", "info");
      return;
    }
    const batch = Math.min(count, 25);
    const seconds = Math.max(1, Math.round((data?.limits.intervalMs ?? 3_000) / 1_000));
    const ok = confirm(
      `Reenviar até ${batch} mensagem(ns)${count > batch ? ` (de ${count}; repita para as demais)` : ""}?\n\n` +
        `O envio é espaçado a cada ${seconds}s e passa por todas as proteções da fila.`
    );
    if (!ok) return;

    const json = await post("retry_all", { scope, limit: 25 });
    if (!json) return;
    reportRetry(json.result);
  }

  async function reviveSelected() {
    if (!selectedJobs.length) return;
    const ok = confirm(
      `Reviver ${selectedJobs.length} job(s) morto(s)?\n\n` +
        "Eles voltam para a fila com o contador de tentativas zerado. Mensagem já entregue não é reenviada."
    );
    if (!ok) return;

    const json = await post("revive_jobs", { ids: selectedJobs });
    if (!json) return;
    setSelectedJobs([]);
    const r = json.result;
    toast(
      `${r.revived ?? 0} job(s) devolvido(s) à fila` +
        (r.skipped ? ` · ${r.skipped} ignorado(s)` : "") +
        (r.errors?.length ? ` · ${r.errors.length} falha(s)` : ""),
      r.errors?.length ? "error" : "success"
    );
  }

  async function reviveAllJobs() {
    const count = data?.counts.deadJobs ?? 0;
    if (!count) {
      toast("Nenhum job morto na fila.", "info");
      return;
    }
    const batch = Math.min(count, 25);
    if (!confirm(`Reviver até ${batch} job(s) morto(s)?${count > batch ? ` Restam ${count - batch} para depois.` : ""}`)) return;

    const json = await post("revive_all_jobs", { limit: 25 });
    if (!json) return;
    const r = json.result;
    toast(
      `${r.revived ?? 0} job(s) devolvido(s) à fila` + (r.skipped ? ` · ${r.skipped} ignorado(s)` : ""),
      r.errors?.length ? "error" : "success"
    );
  }

  async function requeueProcessing() {
    if (
      !confirm(
        "Devolver à fila os jobs presos em PROCESSING há mais de 15 minutos?\n\n" +
          "Use só se a fila realmente estiver parada. Um envio ainda em andamento poderia ser duplicado."
      )
    )
      return;

    const json = await post("requeue_processing");
    if (!json) return;
    toast(`${json.result.requeued ?? 0} job(s) devolvido(s) à fila.`);
  }

  const counts = data?.counts;
  const problems = (counts?.stuck ?? 0) + (counts?.failed ?? 0) + (counts?.deadJobs ?? 0);
  const retryableQueuedIds = data ? data.queued.filter((m) => m.retryable).map((m) => m.id) : [];
  const allQueuedSelected =
    retryableQueuedIds.length > 0 && retryableQueuedIds.every((id) => selected.includes(id));
  const seconds = Math.max(1, Math.round((data?.limits.intervalMs ?? 3_000) / 1_000));

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleJob(id: string) {
    setSelectedJobs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">Fila travada</h2>
            {problems > 0 && <Badge tone="red">{problems} pendência(s)</Badge>}
          </div>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">
            Mostra o que está parado na saída e devolve para a fila <strong>sem duplicar mensagens</strong>.
            Reenvios são espaçados a cada {seconds}s e respeitam pausa, limite de {data?.limits.perHour ?? 60}/hora,
            bloqueio e opt-out. Lembretes agendados para o futuro não são antecipados.
          </p>
        </div>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? "Atualizando..." : "Atualizar"}
        </Button>
      </div>

      {data?.pause.paused && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
          <span>
            Envios pausados{data.pause.reason ? `: ${data.pause.reason}` : ""}.
            {data.pause.until ? ` Retomada prevista: ${new Date(data.pause.until).toLocaleString("pt-BR")}.` : ""}
          </span>
          <Button variant="primary" onClick={() => void resumeQueue()} disabled={busy === "resume"}>
            {busy === "resume" ? "Retomando..." : "▶ Retomar envios"}
          </Button>
        </div>
      )}

      {!data && loading ? (
        <p className="mt-4 text-sm text-zinc-500">Lendo a fila...</p>
      ) : !data ? (
        <p className="mt-4 text-sm text-red-400">Não foi possível ler a fila agora.</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
            <SmallStat label="Travadas" value={counts?.stuck ?? 0} tone="red" />
            <SmallStat label="Aguardando" value={counts?.waiting ?? 0} tone="amber" />
            <SmallStat label="Agendadas" value={counts?.scheduled ?? 0} tone="neutral" />
            <SmallStat label="Com erro (7d)" value={counts?.failed ?? 0} tone="red" />
            <SmallStat label="Jobs mortos (7d)" value={counts?.deadJobs ?? 0} tone="red" />
          </div>

          {problems === 0 && (counts?.processing ?? 0) === 0 && (
            <p className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
              Fila em dia: nenhuma mensagem presa, com erro ou job morto.
            </p>
          )}

          {data.queued.length > 0 && (
            <section className="mt-4 border-t border-zinc-800/60 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-200">
                  Na fila <span className="text-zinc-500">({data.queued.length})</span>
                </h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setSelected(allQueuedSelected ? [] : retryableQueuedIds)}
                    disabled={retryableQueuedIds.length === 0}
                  >
                    {allQueuedSelected ? "Desmarcar" : "Marcar reenviáveis"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void retryAll("queued")}
                    disabled={Boolean(busy) || (counts?.stuck ?? 0) === 0}
                  >
                    Reenviar até 25
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Só as marcáveis podem ser reenviadas. Agendadas para o futuro, aguardando o WhatsApp e em execução ficam de fora.
              </p>

              <ul className="mt-2 max-h-72 divide-y divide-zinc-800/60 overflow-y-auto rounded-lg border border-zinc-800">
                {data.queued.map((m) => (
                  <li key={m.id} className="flex items-start gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-gold-500"
                      checked={selected.includes(m.id)}
                      disabled={!m.retryable}
                      onChange={() => toggle(m.id)}
                      aria-label={`Selecionar mensagem para ${who(m)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-100">{who(m)}</span>
                        <span className="text-[11px] text-zinc-500">{phoneLabel(m.phone)}</span>
                        <Badge tone={SITUATION[m.situation].tone}>{SITUATION[m.situation].label}</Badge>
                        <span className="text-[11px] text-zinc-500">{since(m.createdAt)}</span>
                        {m.templateKey && <span className="font-mono text-[10px] text-zinc-500">{m.templateKey}</span>}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-400">{m.preview || "(sem texto)"}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {m.note ?? (m.job ? `Job ${m.job.status}` : "Sem job na fila")}
                      </p>
                      {m.error && <p className="mt-0.5 text-[11px] text-red-400">{m.error}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {data.truncated.queued && (
                <p className="mt-1 text-[11px] text-zinc-500">Mostrando as 200 primeiras mensagens na fila.</p>
              )}
            </section>
          )}

          {data.failed.length > 0 && (
            <section className="mt-4 border-t border-zinc-800/60 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-200">
                  Com erro <span className="text-zinc-500">({data.failed.length})</span>
                </h3>
                <Button variant="outline" onClick={() => void retryAll("failed")} disabled={Boolean(busy)}>
                  Reenviar até 25
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                O erro fica visível aqui; reenviar usa a mesma linha e a mesma conversa, sem criar uma segunda mensagem no histórico.
                Só entram erros dos últimos 7 dias.
              </p>

              <ul className="mt-2 max-h-72 divide-y divide-zinc-800/60 overflow-y-auto rounded-lg border border-zinc-800">
                {data.failed.map((m) => (
                  <li key={m.id} className="flex items-start gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-gold-500"
                      checked={selected.includes(m.id)}
                      onChange={() => toggle(m.id)}
                      aria-label={`Selecionar mensagem com erro para ${who(m)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-100">{who(m)}</span>
                        <span className="text-[11px] text-zinc-500">{phoneLabel(m.phone)}</span>
                        <Badge tone="red">erro</Badge>
                        <span className="text-[11px] text-zinc-500">{since(m.createdAt)}</span>
                        {m.templateKey && <span className="font-mono text-[10px] text-zinc-500">{m.templateKey}</span>}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-zinc-400">{m.preview || "(sem texto)"}</p>
                      {m.error && <p className="mt-0.5 text-[11px] text-red-400">{m.error}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              {data.truncated.failed && (
                <p className="mt-1 text-[11px] text-zinc-500">Mostrando os 50 erros mais recentes.</p>
              )}
            </section>
          )}

          {data.deadJobs.length > 0 && (
            <section className="mt-4 border-t border-zinc-800/60 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-200">
                  Jobs mortos <span className="text-zinc-500">({data.deadJobs.length})</span>
                </h3>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => void reviveSelected()} disabled={Boolean(busy) || selectedJobs.length === 0}>
                    Reviver selecionados{selectedJobs.length ? ` (${selectedJobs.length})` : ""}
                  </Button>
                  <Button variant="outline" onClick={() => void reviveAllJobs()} disabled={Boolean(busy)}>
                    Reviver até 25
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Job que esgotou as tentativas. Se for envio, a mensagem também volta para QUEUED — mas nunca é reenviada se já saiu.
                Só entram jobs mortos dos últimos 7 dias.
              </p>

              <ul className="mt-2 max-h-72 divide-y divide-zinc-800/60 overflow-y-auto rounded-lg border border-zinc-800">
                {data.deadJobs.map((job) => (
                  <li key={job.id} className="flex items-start gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-gold-500"
                      checked={selectedJobs.includes(job.id)}
                      disabled={!job.retryable}
                      onChange={() => toggleJob(job.id)}
                      aria-label="Selecionar job morto"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-zinc-200">{job.type}</span>
                        <Badge tone="red">DEAD</Badge>
                        <span className="text-[11px] text-zinc-500">
                          {job.attempts}/{job.maxAttempts} tentativas · {since(job.createdAt)}
                        </span>
                        {job.messageStatus && <span className="text-[11px] text-zinc-500">mensagem: {job.messageStatus}</span>}
                      </div>
                      {job.error && <p className="mt-0.5 text-[11px] text-red-400">{job.error}</p>}
                      {job.note && <p className="mt-0.5 text-[11px] text-zinc-500">{job.note}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.processing.length > 0 && (
            <section className="mt-4 border-t border-zinc-800/60 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-200">
                  Em execução há mais de 15 min <span className="text-zinc-500">({data.processing.length})</span>
                </h3>
                <Button variant="ghost" onClick={() => void requeueProcessing()} disabled={Boolean(busy)}>
                  Devolver à fila
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-amber-400">
                Use só se a fila estiver parada: um envio em andamento de verdade poderia ser duplicado.
              </p>

              <ul className="mt-2 max-h-48 divide-y divide-zinc-800/60 overflow-y-auto rounded-lg border border-zinc-800">
                {data.processing.map((job) => (
                  <li key={job.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-zinc-200">{job.type}</span>
                      <Badge tone="amber">PROCESSING</Badge>
                      <span className="text-[11px] text-zinc-500">iniciado {since(job.runAt)}</span>
                      {job.attempts > 0 && <span className="text-[11px] text-zinc-500">{job.attempts} tentativa(s)</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {selected.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold-500/30 bg-gold-500/10 px-3 py-2">
              <span className="text-sm text-gold-200">{selected.length} mensagem(ns) selecionada(s)</span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setSelected([])} disabled={Boolean(busy)}>
                  Limpar
                </Button>
                <Button onClick={() => void retrySelected()} disabled={Boolean(busy)}>
                  {busy === "retry" ? "Reenviando..." : "Reenviar selecionadas"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function SmallStat({ label, value, tone }: { label: string; value: number; tone: "red" | "amber" | "neutral" }) {
  const color = value === 0 ? "text-zinc-400" : tone === "red" ? "text-red-300" : tone === "amber" ? "text-amber-300" : "text-zinc-200";
  const ring = value === 0 ? "border-zinc-800" : tone === "red" ? "border-red-500/30" : tone === "amber" ? "border-amber-500/30" : "border-zinc-800";
  return (
    <div className={`rounded-lg border ${ring} bg-zinc-900/40 px-3 py-2`}>
      <p className={`text-lg font-semibold leading-tight ${color}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
    </div>
  );
}

export default StuckQueuePanel;
