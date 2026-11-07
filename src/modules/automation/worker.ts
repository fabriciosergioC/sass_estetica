// Worker in-process da fila de jobs.
//
// Por que dentro do processo do Next: o socket do Baileys vive na globalThis deste
// processo. Um worker em outro processo (Task Scheduler chamando um script) conseguiria
// ler os jobs, mas NUNCA enviar — cairia em "Baileys não conectado". Para produção em
// serverless, use /api/cron com um agendador externo; aqui o objetivo é o app local
// (iniciar.bat) processar lembretes sem ninguém abrir página nem clicar em botão.
import { processJobs } from "./jobs";

const GLOBAL_KEY = "__automation_worker__" as const;

type WorkerState = {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  ticks: number;
  /** quantos jobs processamos desde que o worker subiu (útil no /app/configuracoes). */
  processed: number;
  /** já fizemos o pente de mensagens presas em QUEUED nesta subida? */
  reconciled?: boolean;
};

function getState(): WorkerState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { timer: null, running: false, ticks: 0, processed: 0, reconciled: false } satisfies WorkerState;
  }
  return g[GLOBAL_KEY] as WorkerState;
}

async function tick() {
  const st = getState();
  if (st.running) return;
  st.running = true;
  st.ticks += 1;

  try {
    // 0) Primeira passada: mensagens que ficaram "aguardando" sem job nenhum (código antigo,
    //    restart no meio do PROCESSING, job DEAD) viram erro visível. Nada é reenviado aqui —
    //    reenviar sozinho seria mandar mensagem que ninguém pediu agora.
    if (!st.reconciled) {
      st.reconciled = true;
      const { reconcileQueuedSends } = await import("@/modules/whatsapp/queue");
      const { marked } = await reconcileQueuedSends();
      if (marked > 0) console.log(`[Worker] 🧹 ${marked} mensagem(es) presa(s) em QUEUED marcadas como erro.`);
    }

    // 1) Retoma a sessão do WhatsApp que tem pareamento salvo (o estado em memória morre a
    //    cada restart do Next; a credencial em disco não). Quem decide QUAL org reconecta é
    //    o serviço, porque há um único socket por processo.
    if (process.env.BAILEYS_AUTO_CONNECT !== "0") {
      const { autoConnectWhatsApp } = await import("@/modules/whatsapp/service");
      const result = await autoConnectWhatsApp();
      if (result.orgId && result.state !== "CONNECTED") {
        console.log(`[Worker] WhatsApp da org ${result.orgId} ficou em ${result.state}.`);
      }
    }

    // 2) Processa o que está vencido.
    const processed = await processJobs(25);
    if (processed > 0) {
      st.processed += processed;
      console.log(`[Worker] ⚙️ ${processed} job(s) processado(s) (total ${st.processed}).`);
    }
  } catch (err) {
    console.error("[Worker] Erro no ciclo de jobs:", err);
  } finally {
    st.running = false;
  }
}

/** Liga o ticker. Idempotente: hot reload não duplica o timer. */
export function startJobWorker(intervalMs = Number(process.env.JOB_WORKER_INTERVAL_MS ?? 60_000)) {
  const st = getState();
  if (st.timer) return false;
  if (intervalMs < 5_000) intervalMs = 5_000;

  st.timer = setInterval(() => void tick(), intervalMs);
  // unref: o timer não segura o processo (importante em `next build`/testes).
  (st.timer as any).unref?.();

  console.log(`[Worker] 🟢 Fila de jobs ativa, ciclo a cada ${intervalMs / 1000}s.`);
  // Primeiro ciclo imediato: lembretes que venceram enquanto o app estava parado.
  void tick();
  return true;
}

export function stopJobWorker() {
  const st = getState();
  if (st.timer) {
    clearInterval(st.timer);
    st.timer = null;
    console.log("[Worker] 🔴 Fila de jobs parada.");
  }
}

export function getWorkerStatus() {
  const st = getState();
  return { running: Boolean(st.timer), ticks: st.ticks, processed: st.processed };
}
