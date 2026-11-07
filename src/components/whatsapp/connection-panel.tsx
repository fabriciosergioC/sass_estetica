"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Field, Input, QRCodeDisplay, Select } from "@/components/ui";
import { toast } from "@/components/toast";
import { CONNECTION_LABEL, CONNECTION_TONE, phoneLabel } from "@/lib/whatsapp-labels";

/**
 * Painel de conexão do WhatsApp (§2, §3, §29, §30).
 *
 * Vive num componente à parte porque a especificação pede a tela em Configurações → WhatsApp
 * e o painel de conversas precisa do MESMO estado (QR, reconectar, fila) no cabeçalho.
 * Duplicar a lógica aqui é o que faria uma tela dizer "Conectado" e a outra "Erro".
 *
 * Nada neste arquivo conhece Baileys: ele fala apenas com as rotas internas do CRM
 * (`/api/whatsapp*`), que por sua vez falam com o WhatsAppService.
 */

export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "WAITING_QR"
  | "CONNECTED"
  | "RECONNECT_REQUIRED"
  | "ERROR";

type ProviderInfo = { name: string; label: string; implemented: boolean; mock: boolean };

type WaView = {
  connectionId: string;
  provider: string;
  mock: boolean;
  state: ConnectionState | string;
  detail: string | null;
  savedStatus: string;
  phone: string | null;
  accountName: string | null;
  lastSyncAt: string | null;
  qr: string | null;
  qrAgeMs: number | null;
  unreadTotal: number;
  openConversations: number;
};

type QrSnapshot = {
  qrCode: string | null;
  createdAt: number | null;
  ageMs: number | null;
  status: string;
  detail: string | null;
  lastStatusCode: number | null;
  justPaired?: boolean;
};

type TestItem = { key: string; label: string; ok: boolean; detail: string | null };

/** Linha da trilha de eventos (§24) — `logWa` já redige segredo antes de gravar. */
type WaLogRow = {
  id: string;
  level: string;
  event: string;
  actor: string | null;
  status: string | null;
  detail: string | null;
  createdAt: string;
};

type BlockedRow = { id: string; phone: string; reason: string; createdAt: string };

/** Como traduzir o motivo gravado em `WhatsAppBlockedNumber.reason`. */
const BLOCKED_REASON: Record<string, string> = {
  opt_out: "pediu para não receber",
  spam: "spam",
  manual: "bloqueio manual",
  invalid: "número inválido",
};

export function WhatsAppConnectionPanel({
  realtime = "off",
  onConnection,
}: {
  /** Como a tela está recebendo eventos agora (§2 pede o status do tempo real). */
  realtime?: "sse" | "polling" | "off";
  /** Avisa o pai o estado vivo — é assim que o painel de conversas liga/desliga o SSE. */
  onConnection?: (view: WaView) => void;
} = {}) {
  const [view, setView] = useState<WaView | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [queue, setQueue] = useState<{ messages: number; jobs: number; paused: boolean; until: string | null; reason: string | null } | null>(null);
  const [pending, setPending] = useState(0);
  const [qr, setQr] = useState<QrSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [testItems, setTestItems] = useState<TestItem[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testMsg, setTestMsg] = useState("Olá! Teste de integração da {{barbearia}}. ✨");

  /* Manutenção do módulo (§12 histórico, §24 trilha, §25 bloqueados, §26 pausa da fila). */
  const [maintenanceNote, setMaintenanceNote] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<WaLogRow[] | null>(null);
  const [logsTotal, setLogsTotal] = useState(0);
  const [showBlocked, setShowBlocked] = useState(false);
  const [blocked, setBlocked] = useState<BlockedRow[] | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);

  const onConnectionRef = useRef(onConnection);
  onConnectionRef.current = onConnection;

  /** Uma chamada só devolve conexão + fila + provedores (§2 evita n pedidos separados). */
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const res = await fetch("/api/whatsapp?pageSize=1&messages=0", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      const v = (data.view ?? null) as WaView | null;
      if (v) {
        setView(v);
        onConnectionRef.current?.(v);
      }
      setQueue(data.queue ?? null);
      setPending(data.metrics?.pending ?? 0);
      if (Array.isArray(data.providers)) setProviders(data.providers);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  const fetchQr = useCallback(async (opts: { silent?: boolean } = {}) => {
    const silent = opts.silent ?? false;
    if (!silent) setQrLoading(true);
    try {
      const res = await fetch("/api/whatsapp/qr", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as QrSnapshot & { error?: string };
      if (!res.ok || data.error) {
        if (!silent) toast(data.error ?? "Não foi possível ler o QR Code.", "error");
        setQr(null);
        return null;
      }
      // Mantemos o snapshot quando há QR OU quando o aparelho acabou de ser pareado
      // (nessa fase o QR some da tela de propósito, enquanto o login conclui).
      setQr(data.qrCode || data.justPaired ? data : null);
      return data;
    } catch {
      if (!silent) toast("Erro ao carregar o QR Code.", "error");
      return null;
    } finally {
      if (!silent) setQrLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const state = view?.state ?? "DISCONNECTED";
  const connected = state === "CONNECTED";
  const wantsQr = state === "WAITING_QR" || state === "CONNECTING" || state === "PENDING_QR";
  const isBaileys = view?.provider === "BARIELS" || view?.mock;

  useEffect(() => {
    // O QR vive na memória do servidor e rotaciona sozinho: a página precisa perguntar por
    // ele sempre que o provedor for WhatsApp Web e estiver sem conexão — inclusive ao
    // recarregar a página, antes de qualquer clique em "Conectar".
    if (!isBaileys || connected) return;

    const tick = async () => {
      await Promise.all([load({ silent: true }), fetchQr({ silent: true })]);
    };
    void tick();
    const id = setInterval(tick, 3_000);

    // Navegador congela setInterval em aba escondida: ao voltar para a aba, atualize na
    // hora — senão o usuário escaneia um QR que venceu enquanto ninguém estava olhando.
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isBaileys, connected, state, load, fetchQr]);

  useEffect(() => {
    // Estando conectado, o painel ainda precisa descobrir se a conexão CAIU: o evento SSE só
    // chega enquanto o processo que segura o socket está vivo. Se ele reiniciar, resta a sonda.
    if (!connected) return;
    const tick = () => void load({ silent: true });
    const id = setInterval(tick, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, load]);

  async function act(action: "connect" | "reconnect" | "disconnect") {
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível concluir.", "error");
      } else if (action === "disconnect") {
        toast("WhatsApp desconectado.");
        setQr(null);
      } else if (data.liveStatus === "CONNECTED") {
        toast("WhatsApp conectado.");
        setQr(null);
      } else if (data.qrAvailable) {
        toast("QR Code pronto — escaneie no WhatsApp.");
      } else {
        toast(data.detail ?? "Conectando... o QR Code aparece em alguns segundos.");
      }
      await Promise.all([load({ silent: true }), fetchQr({ silent: true })]);
    } finally {
      setBusy(false);
    }
  }

  /** Descarta a sessão salva no servidor e pede um QR novo (resolve o caso 401). */
  async function generateNewQr() {
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp/qr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "new" }),
      });
      const data = (await res.json().catch(() => ({}))) as QrSnapshot & { error?: string };
      if (!res.ok || data.error) {
        toast(data.error ?? "Não foi possível gerar um novo QR Code.", "error");
      } else if (data.qrCode) {
        setQr(data);
        toast("Novo QR Code gerado — escaneie no WhatsApp.");
      } else {
        toast(data.detail ?? "O QR ainda não ficou pronto. Tente novamente em alguns segundos.");
      }
      await load({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  async function changeProvider(name: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_provider", provider: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast(data.error ?? "Não foi possível trocar o provedor.", "error");
      else toast(`Provedor alterado para ${name}.`);
      await load({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  /** §30 — cada item da lista é uma medição diferente, não um enfeite. */
  async function runConnectionTest() {
    setTesting(true);
    try {
      const res = await fetch("/api/whatsapp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connection" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "O teste não pôde ser executado.", "error");
        setTestItems(null);
        return;
      }
      setTestItems(Array.isArray(data.items) ? data.items : []);
    } finally {
      setTesting(false);
    }
  }

  async function sendTest() {
    if (!testPhone || !testMsg) {
      toast("Preencha telefone e mensagem.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/whatsapp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: testPhone, message: testMsg }),
      });
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok) {
        toast(data.error ?? "Não foi possível enviar.", "error");
        return;
      }
      toast(
        data.status === "DELIVERED" || data.status === "READ"
          ? `Mensagem ${data.status === "READ" ? "lida" : "entregue"} no celular do destinatário.`
          : 'Enviada — o servidor do WhatsApp aceitou. O status vira "Entregue" quando o celular dele confirmar (dois risquinhos).'
      );
      setTestPhone("");
      void load({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  /**
   * §12 — traz as mensagens gravadas antes de a conversa existir para dentro do painel.
   * Idempotente e sem envio: só cria contato/conversa a partir do número já salvo.
   */
  async function runBackfill() {
    setBackfilling(true);
    try {
      const res = await fetch("/api/whatsapp/admin/backfill", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível reorganizar o histórico.", "error");
        return;
      }
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      setMaintenanceNote(
        `Histórico reorganizado: ${data.linked ?? 0} de ${data.scanned ?? 0} mensagem(ns) ligada(s) a uma conversa` +
          (skipped ? `; ${skipped} sem número discável ficaram de fora.` : ".")
      );
      toast("Histórico reorganizado.");
      void load({ silent: true });
    } finally {
      setBackfilling(false);
    }
  }

  async function togglePause() {
    const action = queue?.paused ? "resume" : "pause";
    setPauseBusy(true);
    try {
      const res = await fetch("/api/whatsapp/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: action === "pause" ? "Pausado pelo painel de conexão" : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível alterar a fila.", "error");
        return;
      }
      toast(action === "pause" ? "Envios em fila pausados. Retome quando quiser." : "Envios retomados.");
      await load({ silent: true });
    } finally {
      setPauseBusy(false);
    }
  }

  async function toggleLogs() {
    const next = !showLogs;
    setShowLogs(next);
    if (next && logs === null) {
      const data = await fetch("/api/whatsapp/logs?pageSize=15", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => ({}));
      setLogs(Array.isArray(data.items) ? data.items : []);
      setLogsTotal(data.total ?? 0);
    }
  }

  async function toggleBlocked() {
    const next = !showBlocked;
    setShowBlocked(next);
    if (next && blocked === null) {
      const data = await fetch("/api/whatsapp/blocked", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => ({}));
      setBlocked(Array.isArray(data.items) ? data.items : []);
    }
  }

  async function unblockNumber(phone: string) {
    const res = await fetch("/api/whatsapp/blocked", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unblock", phone }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error ?? "Não foi possível liberar o número.", "error");
      return;
    }
    setBlocked((prev) => (prev ?? []).filter((b) => b.phone !== phone));
    toast("Número liberado para receber mensagens.");
  }

  const detail = view?.detail ?? qr?.detail ?? null;
  const qrCode = qr?.qrCode ?? view?.qr ?? null;
  const qrAgeSec = qr?.ageMs ?? view?.qrAgeMs ?? null;
  const accountName = view?.accountName ?? null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* Foto do perfil: quando o WhatsApp ainda não nos deu imagem, usamos as iniciais
              em vez de inventar um avatar — a legenda diz exatamente o que é. */}
          <div
            className="grid size-12 shrink-0 place-items-center rounded-full border border-zinc-700 bg-zinc-800 text-sm font-semibold text-gold-400"
            title={accountName ? `Perfil: ${accountName}` : "Sem nome de perfil retornado pelo WhatsApp"}
          >
            {(accountName ?? "?").slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">Conexão</h2>
              <Badge tone={CONNECTION_TONE[state] ?? "amber"}>{CONNECTION_LABEL[state] ?? state}</Badge>
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {phoneLabel(view?.phone)}
              {accountName ? ` · ${accountName}` : ""}
            </p>
            <p className="mt-0.5 text-xs text-zinc-600">
              {view?.mock ? "Provedor simulado (WHATSAPP_MOCK=true) — nada sai do banco." : `Provedor: ${view?.provider ?? "—"}`}
              {view?.lastSyncAt ? ` · última sincronização ${new Date(view.lastSyncAt).toLocaleString("pt-BR")}` : " · sem sincronização registrada"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {!connected && (
            <Button
              variant="secondary"
              onClick={generateNewQr}
              disabled={busy}
              title="Apaga a sessão salva no servidor e pede um QR Code novo ao WhatsApp"
            >
              🔄 Gerar novo QR
            </Button>
          )}
          {!connected && (
            <Button variant="outline" onClick={() => act("reconnect")} disabled={busy} title="Reconecta do zero, sem apagar o pareamento salvo">
              Reconectar
            </Button>
          )}
          <Button
            variant={connected ? "danger" : "primary"}
            onClick={() => act(connected ? "disconnect" : "connect")}
            disabled={busy}
          >
            {busy ? "Aguarde..." : connected ? "Desconectar" : "Conectar WhatsApp"}
          </Button>
        </div>
      </div>

      {/* Linhas de estado que a §2 exige e que antes só existiam no banco. */}
      <div className="mt-4 grid gap-2 border-t border-zinc-800/60 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="API / provedor" value={view ? (view.mock ? "simulada" : "ativa") : "carregando..."} tone={view ? "green" : "amber"} />
        <Stat label="Tempo real (eventos)" value={realtime === "sse" ? "SSE conectado" : realtime === "polling" ? "sondando a cada 8s" : "desligado"} tone={realtime === "off" ? "amber" : "green"} />
        <Stat label="Mensagens pendentes" value={`${(queue?.messages ?? 0) + (pending ?? 0)} na saída`} tone={(queue?.messages ?? 0) + (pending ?? 0) > 0 ? "amber" : "neutral"} />
        <Stat label="Fila" value={queue?.paused ? `pausada${queue.reason ? ` (${queue.reason})` : ""}` : `${queue?.jobs ?? 0} job(s) aguardando`} tone={queue?.paused ? "red" : "neutral"} />
      </div>

      {detail && (
        <p className={`mt-3 text-xs ${state === "ERROR" ? "text-red-400" : "text-zinc-500"}`}>
          {state === "ERROR" ? "Erro de conexão: " : ""}
          {detail}
        </p>
      )}

      {/* QR Code (§3) */}
      {isBaileys && !connected && (
        <div className="mt-4 border-t border-zinc-800/60 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">
              {qr?.justPaired && !qr.qrCode
                ? "📲 Aparelho pareado, concluindo o login..."
                : qrCode
                  ? "📱 Escaneie o QR Code"
                  : wantsQr
                    ? "Gerando o QR Code..."
                    : "QR Code indisponível no momento"}
            </h3>
            <Button variant="ghost" onClick={() => fetchQr()} disabled={qrLoading}>
              {qrLoading ? "Carregando..." : "Atualizar agora"}
            </Button>
          </div>

          {qrCode ? (
            <div className="space-y-3">
              <QRCodeDisplay qrCode={qrCode} size={200} />
              <div className="rounded-lg bg-zinc-900/50 p-3 text-sm text-zinc-300">
                <p className="mb-1 font-medium">Como conectar:</p>
                <ol className="list-inside list-decimal space-y-1">
                  <li>Abra o WhatsApp no celular</li>
                  <li>Toque em ⋮ (três pontos) → <strong>Aparelhos conectados</strong></li>
                  <li>Toque em <strong>Conectar aparelho</strong></li>
                  <li>Escaneie o QR Code acima</li>
                  <li>Aguarde aparecer "Conectado" aqui</li>
                </ol>
                <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-400">
                  ⚠️ O QR expira em cerca de 20 segundos
                  {qrAgeSec != null ? ` (este foi gerado há ${Math.round(qrAgeSec / 1000)}s)` : ""}.
                  Esta tela renova automaticamente a cada 3s — se ele sumir, clique em "Gerar novo QR".
                </div>
              </div>
            </div>
          ) : qr?.justPaired ? (
            <div className="flex items-center justify-center py-8 text-zinc-300">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              <span className="ml-3 max-w-sm">
                📲 Aparelho pareado! O WhatsApp manda reiniciar a conexão agora — isso conclui o login em alguns
                segundos. Não feche esta página.
              </span>
            </div>
          ) : wantsQr ? (
            <div className="flex items-center justify-center py-8 text-zinc-500">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-gold-500 border-t-transparent" />
              <span className="ml-3">Aguardando o WhatsApp responder (na primeira vez pode levar ~30s)...</span>
            </div>
          ) : (
            <div className="py-4 text-center text-zinc-500">
              <p>Clique em "Conectar WhatsApp" para gerar o QR Code.</p>
              {detail && <p className="mt-1 text-xs text-zinc-600">{detail}</p>}
              <p className="mt-1 text-xs">
                Se aqui aparecer "aparelho removido do WhatsApp", a sessão salva não vale mais: use "Gerar novo QR"
                para começar do zero.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Provedor (§29) — trocar é configuração, não código. */}
      {providers.length > 0 && (
        <div className="mt-4 grid gap-3 border-t border-zinc-800/60 pt-4 sm:max-w-xs">
          <Field label="WhatsApp Provider" hint="Os demais provedores aparecem listados como indisponíveis até terem um adapter.">
            <Select
              value={view?.provider ?? ""}
              disabled={busy}
              onChange={(e) => changeProvider(e.target.value)}
            >
              <option value="">Selecione...</option>
              {providers.map((p) => (
                <option key={p.name} value={p.name} disabled={!p.implemented}>
                  {p.label}
                  {p.implemented ? "" : " (em breve)"}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {/* Teste de conexão (§30) */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-800/60 pt-4">
        <Button variant="outline" onClick={runConnectionTest} disabled={testing || loading}>
          {testing ? "Testando..." : "🧪 Testar conexão"}
        </Button>
        <Button variant="ghost" onClick={() => setShowSend((v) => !v)}>
          {showSend ? "Ocultar envio avulso" : "Enviar mensagem avulsa"}
        </Button>
        {testItems && (
          <ul className="w-full space-y-1 text-sm">
            {testItems.map((it) => (
              <li key={it.key} className="flex items-start gap-2">
                <span className={it.ok ? "text-emerald-400" : "text-red-400"}>{it.ok ? "✓" : "✗"}</span>
                <span className="text-zinc-300">{it.label}</span>
                {it.detail && <span className="text-xs text-zinc-500">— {it.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showSend && (
        <div className="mt-4 border-t border-zinc-800/60 pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Telefone (com DDI + DDD)" hint="Uso pontual; o atendimento normal acontece no painel de conversas.">
              <Input placeholder="5531987707962" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
            </Field>
            <Field label="Mensagem" hint="Variáveis: {{barbearia}} {{nome}} {{empresa}} {{telefone}}">
              <Input value={testMsg} onChange={(e) => setTestMsg(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={sendTest} disabled={busy || !connected}>
              📤 Enviar teste
            </Button>
          </div>
          {!connected && <p className="mt-2 text-xs text-zinc-600">Conecte o WhatsApp para habilitar envios.</p>}
        </div>
      )}

      {/* ---------------------------------------------------- manutenção do módulo */}
      <div className="mt-4 border-t border-zinc-800/60 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void runBackfill()}
            disabled={backfilling}
            title="Liga as mensagens antigas, que entraram sem conversa, às conversas da tela. Não envia nada."
          >
            {backfilling ? "Reorganizando..." : "🧹 Reorganizar histórico"}
          </Button>
          <Button
            variant={queue?.paused ? "primary" : "ghost"}
            onClick={() => void togglePause()}
            disabled={pauseBusy}
            title="Pausa os envios em fila (lembretes e automações). O atendimento manual no painel continua normal."
          >
            {queue?.paused ? "▶ Retomar envios da fila" : "⏸ Pausar envios da fila"}
          </Button>
          <Button variant="ghost" onClick={() => void toggleLogs()}>
            {showLogs ? "Ocultar trilha de eventos" : "Ver trilha de eventos"}
          </Button>
          <Button variant="ghost" onClick={() => void toggleBlocked()}>
            {showBlocked ? "Ocultar bloqueados" : "Ver bloqueados / opt-out"}
          </Button>
        </div>

        {maintenanceNote && <p className="mt-2 text-xs text-zinc-400">{maintenanceNote}</p>}
        {queue?.paused && (
          <p className="mt-2 text-xs text-amber-400">
            Fila pausada{queue.reason ? `: ${queue.reason}` : ""}. Os envios automáticos ficam parados até você retomar.
          </p>
        )}

        {showLogs && (
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-800">
            {!logs || logs.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-500">Nenhum evento registrado ainda.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {logs.map((l) => (
                  <li key={l.id} className="flex items-start gap-2 px-3 py-2">
                    <span
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                        l.level === "error" ? "bg-red-400" : l.level === "warn" ? "bg-amber-400" : "bg-zinc-600"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-zinc-200">
                        <span className="font-mono">{l.event}</span>
                        {l.status && <span className="text-zinc-500"> · {l.status}</span>}
                      </p>
                      {l.detail && <p className="truncate text-[11px] text-zinc-500">{l.detail}</p>}
                    </div>
                    <span className="shrink-0 text-[11px] text-zinc-600">
                      {new Date(l.createdAt).toLocaleTimeString("pt-BR")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="bg-zinc-900/60 px-3 py-1.5 text-[11px] text-zinc-600">
              {logsTotal} evento(s) no total · token, chave de sessão e QR nunca são gravados aqui.
            </p>
          </div>
        )}

        {showBlocked && (
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-800">
            {!blocked || blocked.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-500">Nenhum número bloqueado nesta clínica.</p>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {blocked.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{phoneLabel(b.phone)}</span>
                    <Badge tone="red">{BLOCKED_REASON[b.reason] ?? b.reason}</Badge>
                    <button
                      onClick={() => void unblockNumber(b.phone)}
                      className="shrink-0 text-[11px] text-gold-400 hover:text-gold-300"
                    >
                      liberar
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="bg-zinc-900/60 px-3 py-1.5 text-[11px] text-zinc-600">
              O bloqueio vale só para esta clínica. Quem pediu para sair também aparece no cadastro do cliente.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "green" | "amber" | "red" | "neutral" }) {
  const color =
    tone === "green" ? "text-emerald-400" : tone === "amber" ? "text-amber-400" : tone === "red" ? "text-red-400" : "text-zinc-300";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-0.5 truncate text-sm ${color}`} title={value}>
        {value}
      </p>
    </div>
  );
}

export default WhatsAppConnectionPanel;
