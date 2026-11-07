/**
 * Hook de inicialização do servidor (Next 15).
 * Roda uma vez por processo Node, antes da primeira requisição, e liga o worker da
 * fila de jobs — é o que fazia falta para lembretes/confirmações saírem sozinhos.
 *
 * A comparação precisa ser `=== "nodejs"` e envolver o import. O Next compila este
 * arquivo duas vezes (runtime `nodejs` e runtime `edge`); no bundle edge o
 * `process.env.NEXT_RUNTIME` é substituído por um literal, então o bloco inteiro é
 * removido na compilação. Sem isso, o webpack tenta bundlar Baileys/sharp no runtime
 * edge e a compilação quebra em `Can't resolve 'child_process'`/'audio-decode'.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.JOB_WORKER_ENABLED === "0") {
      console.log("[Instrumentation] JOB_WORKER_ENABLED=0 — worker de jobs desligado (use /api/cron).");
      return;
    }

    const { startJobWorker } = await import("@/modules/automation/worker");
    startJobWorker();
  }
}
