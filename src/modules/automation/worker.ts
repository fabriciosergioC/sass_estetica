// Worker in-process da fila de jobs.
//
// Por que dentro do processo do Next: o socket do Baileys vive na globalThis deste
// processo. Um worker em outro processo (Task Scheduler chamando um script) conseguiria
// ler os jobs, mas NUNCA enviar — cairia em "Baileys não conectado". Para produção em
// serverless, use /api/cron com um agendador externo; aqui o objetivo é o app do dia a dia
// processar lembretes sem ninguém abrir página nem clicar em botão.
//
// O agendamento é DINÂMICO: em vez de um tique fixo, o worker dorme até o próximo `runAt`
// pendente (com teto de JOB_WORKER_INTERVAL_MS como rede de segurança). Um job espaçado para
// daqui a 3s é executado em ~3s, não no próximo minuto.
import { nextPendingRunAt, processJobs, requeueOrphanProcessing } from "./jobs";

const GLOBAL_KEY = "__automation_worker__" as const;
/** Reconexão do WhatsApp não precisa ser tentada a cada acordada curta da fila. */
const AUTO_CONNECT_EVERY_MS = 60_000;

type WorkerState = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** false quando JOB_WORKER_ENABLED=0 (nesse caso só /api/cron processa). */
  enabled: boolean;
  ticks: number;
  /** quantos jobs processamos desde que o worker subiu (útil no /app/configuracoes). */
  processed: number;
  /** já fizemos o pente de mensagens presas em QUEUED nesta subida? */
  reconciled?: boolean;
  lastAutoConnectAt: number;
  /** Teto de sossego: nunca dormir mais que isso, mesmo sem job pendente. */
  maxIdleMs: number;
};

function getState(): WorkerState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      timer: null,
      running: false,
      enabled: false,
      ticks: 0,
      processed: 0,
      reconciled: false,
      lastAutoConnectAt: 0,
      maxIdleMs: 60_000,
    } satisfies WorkerState;
  }
  return g[GLOBAL_KEY] as WorkerState;
}

async function tick() {
  const st = getState();
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  if (st.running) return;
  st.running = true;
  st.ticks += 1;

  try {
    // 0) Primeira passada: mensagens que ficaram "aguardando" sem job nenhum (código antigo,
    //    restart no meio do PROCESSING, job DEAD) viram erro visível. Nada é reenviado aqui —
    //    reenviar sozinho seria mandar mensagem que ninguém pediu agora.
    if (!st.reconciled) {
      st.reconciled = true;
      // Jobs que estavam em PROCESSING quando o processo caiu voltam para a fila. Isto
      // PRECISA vir antes do pente de mensagens: senão o job órfão conta como "vivo" e a
      // mensagem fica presa em QUEUED para sempre (visto a cada deploy na Railway).
      const revived = await requeueOrphanProcessing();
      if (revived > 0) console.log(`[Worker] ♻️ ${revived} job(s) órfão(s) em PROCESSING devolvido(s) à fila.`);

      const { reconcileQueuedSends } = await import("@/modules/whatsapp/queue");
      const { marked } = await reconcileQueuedSends();
      if (marked > 0) console.log(`[Worker] 🧹 ${marked} mensagem(es) presa(s) em QUEUED marcadas como erro.`);
    }

    // 1) Retoma a sessão do WhatsApp que tem pareamento salvo (o estado em memória morre a
    //    cada restart do Next; a credencial em disco não). Quem decide QUAL org reconecta é
    //    o serviço, porque há um único socket por processo. Com acordadas de poucos segundos,
    //    isso fica limitado a uma tentativa por minuto — antes o tique era sempre de 60s.
    if (process.env.BAILEYS_AUTO_CONNECT !== "0" && Date.now() - st.lastAutoConnectAt >= AUTO_CONNECT_EVERY_MS) {
      st.lastAutoConnectAt = Date.now();
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
    void scheduleNext();
  }
}

/** Dorme até o próximo job pendente (nunca além de maxIdleMs). */
async function scheduleNext() {
  const st = getState();
  if (!st.enabled || st.running || st.timer) return;

  const next = await nextPendingRunAt().catch(() => null);
  // Um wake() pode ter agendado um tique enquanto consultávamos o banco.
  if (!st.enabled || st.running || st.timer) return;

  const delay = next
    ? Math.min(Math.max(next.getTime() - Date.now() + 25, 50), st.maxIdleMs)
    : st.maxIdleMs;

  st.timer = setTimeout(() => void tick(), delay);
  // unref: o timer não segura o processo (importante em `next build`/testes).
  (st.timer as any).unref?.();
}

/**
 * Acorda o worker agora. Chamado quando um job nasce ou é reprogramado: sem isso, um envio
 * espaçado para daqui a 3s esperaria o tique de segurança de até 60s.
 */
export function wakeJobWorker(delayMs = 0) {
  const st = getState();
  // Worker desligado (JOB_WORKER_ENABLED=0): quem processa é o /api/cron.
  if (!st.enabled) return;
  // Tick em andamento: o `finally` dele reagenda a partir do banco.
  if (st.running) return;

  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  st.timer = setTimeout(() => void tick(), Math.max(0, delayMs));
  (st.timer as any).unref?.();
}

/** Liga o agendador. Idempotente: hot reload não duplica o timer. */
export function startJobWorker(intervalMs = Number(process.env.JOB_WORKER_INTERVAL_MS ?? 60_000)) {
  const st = getState();
  if (st.enabled) return false;

  // O valor antigo era o ciclo fixo; agora é o teto de sossego. Piso de 5s evita laço.
  st.maxIdleMs = Math.max(5_000, Number.isFinite(intervalMs) ? intervalMs : 60_000);
  st.enabled = true;

  console.log(
    `[Worker] 🟢 Fila de jobs ativa; acorda no vencimento (sossego máximo de ${st.maxIdleMs / 1000}s).`
  );
  // Primeiro ciclo imediato: lembretes que venceram enquanto o app estava parado.
  void tick();
  return true;
}

export function stopJobWorker() {
  const st = getState();
  st.enabled = false;
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
    console.log("[Worker] 🔴 Fila de jobs parada.");
  }
}

export function getWorkerStatus() {
  const st = getState();
  return { running: st.enabled, ticks: st.ticks, processed: st.processed };
}
