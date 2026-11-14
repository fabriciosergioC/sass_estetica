"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { toast } from "@/components/toast";
import { WhatsAppConnectionPanel } from "@/components/whatsapp/connection-panel";
import { StuckQueuePanel } from "@/components/whatsapp/stuck-queue-panel";

import {
  CONNECTION_LABEL,
  FILTER_LABEL,
  MSG_LABEL,
  MSG_TONE,
  STATUS_LABEL,
  phoneLabel,
  previewBody,
  shortTime,
  dayLabel,
} from "@/lib/whatsapp-labels";

/**
 * Painel de conversas do WhatsApp (§4 a §7) — duas colunas: lista | conversa.
 *
 * A terceira coluna ("dados do lead") foi pedida fora do escopo e saiu; o que o atendente
 * precisa no dia a dia — situação e responsável da conversa — foi para o cabeçalho dela,
 * e o resto do cadastro continua em /app/clientes/[id]. As rotas /labels, /timeline e
 * /follow-ups permanecem no backend, prontas caso a tela volte.
 *
 * Toda a fala com o WhatsApp passa pelas rotas internas (`/api/whatsapp/*`), que por sua vez
 * passam pelo WhatsAppService. Nada aqui sabe que o Baileys existe: é isso que faz a tela
 * funcionar igual com o WhatsApp real, com outro provedor no futuro, e no modo mock (§32).
 *
 * As datas chegam como string ISO do JSON; nada de `Date` no estado do React.
 */

type Contact = { id: string; jid: string; name: string | null; phone: string | null; masked: boolean };

type ConversationItem = {
  id: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string;
  lastBody: string | null;
  assigneeName: string | null;
  contact: Contact;
  customer: { id: string; name: string; phone: string } | null;
  labels: { id: string; name: string; color: string }[];
  lastMessage: { direction: string; body: string; createdAt: string; status: string } | null;
};

type MediaRow = {
  id: string;
  kind: string;
  url: string | null;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
};

type MessageRow = {
  id: string;
  direction: string;
  body: string;
  messageType: string;
  status: string;
  error: string | null;
  templateKey: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  media?: MediaRow[];
};

type Thread = {
  id: string;
  status: string;
  unreadCount: number;
  assigneeId: string | null;
  customerId: string | null;
  contact: Contact;
  customer: { id: string; name: string; phone: string; whatsappOptIn: boolean; notes?: { id: string; content: string }[] } | null;
  assignee: { id: string; name: string } | null;
  labels: { id: string; name: string; color: string }[];
  followUps: { id: string; scheduledAt: string; reason: string; status: string }[];
  messages: MessageRow[];
};

type QuickReply = { id: string; shortcut: string; title: string | null; body: string };
type TeamMember = { id: string; name: string; email: string; role: string };

/** O que /api/whatsapp/metrics devolve; tudo opcional porque a tela continua útil sem número. */
type PanelMetrics = {
  receivedToday: number;
  sentToday: number;
  openConversations: number;
  answeredToday: number;
  contactedToday: number;
  failed: number;
  followUpsPending: number;
  delivery: { successRate: number | null };
};

const FILTERS = ["all", "appointments", "in_progress", "waiting", "done"];
const STATUS_OPTIONS = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "DONE"];

/** Limite prático do anexo: o data URL viaja no corpo do POST (a rota aceita até ~16 MB de texto). */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export default function WhatsAppInboxPage() {
  const [filter, setFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [realtime, setRealtime] = useState<"sse" | "polling" | "off">("off");

  /** Celular: uma coluna por vez (§28). */
  const [mobileView, setMobileView] = useState<"list" | "thread">("list");

  const fileInput = useRef<HTMLInputElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const newPhone = useRef("");
  const [showNewChat, setShowNewChat] = useState(false);

  const [qrForm, setQrForm] = useState({ shortcut: "", body: "" });

  /* Indicadores do topo (§20). */
  const [metrics, setMetrics] = useState<PanelMetrics | null>(null);

  /* ------------------------------------------------------------------ leitura */

  const loadConversations = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoadingList(true);
      try {
        const params = new URLSearchParams({ filter, pageSize: "60" });
        if (search) params.set("search", search);
        const res = await fetch(`/api/whatsapp/conversations?${params}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setItems(data.items ?? []);
          setTeam(data.team ?? []);
        }
      } finally {
        if (!opts.silent) setLoadingList(false);
      }
    },
    [filter, search]
  );

  const loadThread = useCallback(async (id: string, opts: { markRead?: boolean; silent?: boolean } = {}) => {
    if (!opts.silent) setLoadingThread(true);
    try {
      const params = new URLSearchParams({ limit: "120" });
      if (opts.markRead !== false) params.set("markRead", "1");
      const res = await fetch(`/api/whatsapp/conversations/${id}?${params}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setThread(data.conversation ?? null);
      else toast(data.error ?? "Não foi possível abrir a conversa.", "error");
    } finally {
      if (!opts.silent) setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // A busca digita a cada tecla; só pergunta ao servidor depois de 400ms parado.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    void (async () => {
      const q = await fetch("/api/whatsapp/quick-replies", { cache: "no-store" }).then((r) => r.json().catch(() => ({})));
      setQuickReplies(q.items ?? []);
    })();
  }, []);

  /** Indicadores do topo (§20). Falhou? A tela segue funcionando sem os números. */
  const loadMetrics = useCallback(async () => {
    const m: Record<string, any> = await fetch("/api/whatsapp/metrics", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    if (typeof m?.receivedToday !== "number") return;
    setMetrics({
      receivedToday: m.receivedToday,
      sentToday: m.sentToday ?? 0,
      openConversations: m.openConversations ?? 0,
      answeredToday: m.answeredToday ?? 0,
      contactedToday: m.contactedToday ?? 0,
      failed: m.failed ?? 0,
      followUpsPending: m.followUpsPending ?? 0,
      delivery: { successRate: m.delivery?.successRate ?? null },
    });
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  // Abre a primeira conversa da lista na chegada (desktop); no celular mantém a lista.
  useEffect(() => {
    if (selectedId || items.length === 0) return;
    if (window.matchMedia("(min-width: 1024px)").matches) void open(items[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selectedId]);

  // Mantém a conversa na última mensagem quando ela cresce.
  useEffect(() => {
    const box = scrollBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [thread?.messages.length, selectedId]);

  // Trocou de conversa: o rascunho e o formulário de nova conversa não podem acompanhar.
  useEffect(() => {
    setDraft("");
    setShowNewChat(false);
  }, [selectedId]);

  /* ------------------------------------------------------------- tempo real §19 */

  const refreshAll = useCallback(async () => {
    await Promise.all([
      loadConversations({ silent: true }),
      loadMetrics(),
      selectedId ? loadThread(selectedId, { markRead: false, silent: true }) : Promise.resolve(),
    ]);
  }, [loadConversations, loadMetrics, loadThread, selectedId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      setRealtime("polling");
      return;
    }
    const source = new EventSource("/api/whatsapp/events?topics=message.upsert,message.status,conversation.changed,connection.status,dashboard.changed");
    const touch = () => void refreshAll();
    const names = ["message.upsert", "message.status", "conversation.changed", "connection.status", "dashboard.changed"];
    for (const name of names) source.addEventListener(name, touch);
    source.onopen = () => setRealtime("sse");
    source.onerror = () => setRealtime("polling");
    return () => {
      for (const name of names) source.removeEventListener(name, touch);
      source.close();
    };
  }, [refreshAll]);

  // Rede de segurança do SSE: aba escondida perde evento, e setInterval congela lá — por isso
  // o refresco também acontece quando a aba volta para a frente.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshAll]);

  useEffect(() => {
    if (realtime !== "sse") return; // com SSE o servidor empurra; sem ele, sonda.
    const id = setInterval(() => void refreshAll(), 8_000);
    return () => clearInterval(id);
  }, [realtime, refreshAll]);

  /* -------------------------------------------------------------------- escrita */

  async function open(id: string) {
    setSelectedId(id);
    setMobileView("thread");
    await loadThread(id);
  }

  async function patchConversation(body: Record<string, unknown>) {
    if (!selectedId) return null;
    const res = await fetch(`/api/whatsapp/conversations/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? "Não foi possível atualizar a conversa.", "error");
      return null;
    }
    if (data.conversation) setThread(data.conversation);
    void loadConversations({ silent: true });
    return data;
  }

  async function sendMessage(body: string, media?: { kind: string; url: string; fileName?: string; mimeType?: string }) {
    if (!selectedId) return;
    setSending(true);
    try {
      const res = await fetch("/api/whatsapp/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: selectedId, body, media, immediate: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível enviar.", "error");
      } else {
        toast(
          data.status === "DELIVERED" || data.status === "READ"
            ? "Entregue no celular do destinatário."
            : 'Enviada — o servidor do WhatsApp aceitou. Vira "Entregue" quando o celular confirmar.'
        );
        if (!media) setDraft("");
      }
      await loadThread(selectedId, { markRead: false, silent: true });
      void loadConversations({ silent: true });
    } finally {
      setSending(false);
    }
  }

  async function pickAttachment(file: File | undefined) {
    if (!file || !selectedId) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`Anexo muito grande (${Math.round(file.size / 1024 / 1024)} MB). O limite é 3 MB.`.trim(), "error");
      return;
    }
    const kind = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
          ? "audio"
          : "document";
    const reader = new FileReader();
    reader.onerror = () => toast("Não foi possível ler o arquivo.", "error");
    reader.onload = async () => {
      await sendMessage(draft.trim(), { kind, url: String(reader.result), fileName: file.name, mimeType: file.type || "application/octet-stream" });
      if (fileInput.current) fileInput.current.value = "";
    };
    reader.readAsDataURL(file);
  }

  async function startConversation() {
    const phone = newPhone.current.replace(/\D/g, "");
    if (phone.length < 10) {
      toast("Informe o número com DDI e DDD (ex.: 5531987707962).", "error");
      return;
    }
    const res = await fetch("/api/whatsapp/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? "Não foi possível abrir a conversa.", "error");
      return;
    }
    setShowNewChat(false);
    newPhone.current = "";
    await loadConversations({ silent: true });
    if (data.conversation?.id) void open(data.conversation.id);
  }

  async function saveQuickReply() {
    const shortcut = qrForm.shortcut.replace(/^\//, "").trim();
    if (!shortcut || !qrForm.body.trim()) {
      toast("Preencha atalho e mensagem.", "error");
      return;
    }
    const res = await fetch("/api/whatsapp/quick-replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut, body: qrForm.body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? "Não foi possível salvar a resposta rápida.", "error");
      return;
    }
    toast(`Salva: /${shortcut}`);
    setQrForm({ shortcut: "", body: "" });
    const all = await fetch("/api/whatsapp/quick-replies", { cache: "no-store" }).then((r) => r.json().catch(() => ({})));
    setQuickReplies(all.items ?? []);
  }

  async function deleteQuickReply(id: string) {
    const res = await fetch(`/api/whatsapp/quick-replies?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error ?? "Não foi possível excluir.", "error");
      return;
    }
    setQuickReplies((prev) => prev.filter((r) => r.id !== id));
  }

  /* ------------------------------------------------------------------ derivados */

  const shortcuts = useMemo(() => {
    const typed = draft.match(/^\/([a-z0-9_-]*)$/i);
    if (!typed) return [];
    const needle = typed[1].toLowerCase();
    return quickReplies.filter((r) => r.shortcut.toLowerCase().startsWith(needle)).slice(0, 6);
  }, [draft, quickReplies]);

  const byDay = useMemo(() => {
    const groups: { day: string; rows: MessageRow[] }[] = [];
    for (const m of thread?.messages ?? []) {
      const day = dayLabel(m.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.rows.push(m);
      else groups.push({ day, rows: [m] });
    }
    return groups;
  }, [thread]);

  /* ---------------------------------------------------------------------- render */

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">WhatsApp</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connected ? "green" : "amber"}>{connected ? "WhatsApp conectado" : "WhatsApp desconectado"}</Badge>
          <Badge tone={realtime === "sse" ? "green" : "neutral"}>{realtime === "sse" ? "ao vivo (SSE)" : "sondando"}</Badge>
          <Button variant="outline" onClick={() => setShowNewChat((v) => !v)}>
            ＋ Nova conversa
          </Button>
        </div>
      </header>

      {/* Indicadores do módulo (§20). Vêm do mesmo /metrics que o painel usa; nada é
          calculado no navegador para não discordar do banco. */}
      {metrics && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label="Aguardando resposta" value={metrics.openConversations} tone={metrics.openConversations > 0 ? "amber" : undefined} />
          <Kpi
            label="Leads que responderam"
            value={`${metrics.answeredToday}/${metrics.contactedToday}`}
            hint="Só conta número identificado: @lid mascarado não prova que a pessoa respondeu."
          />
          <Kpi label="Follow-ups pendentes" value={metrics.followUpsPending} tone={metrics.followUpsPending > 0 ? "gold" : undefined} />
          <Kpi
            label="Entrega"
            value={metrics.delivery.successRate != null ? `${metrics.delivery.successRate}%` : "—"}
            hint={metrics.failed > 0 ? `${metrics.failed} mensagem(ns) com erro no histórico.` : "Nenhuma falha de envio registrada."}
            tone={metrics.failed > 0 ? "red" : undefined}
          />
        </div>
      )}
      {showNewChat && (
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Field label="Número do WhatsApp" hint="Precisa ser de um cliente já cadastrado no menu Clientes (ou pela Agenda).">
                <Input placeholder="5531987707962" onChange={(e) => (newPhone.current = e.target.value)} />
              </Field>
            </div>
            <Button onClick={startConversation}>Abrir conversa</Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        {/* ------------------------------------------------------------- COLUNA 1 */}
        <Card className={`${mobileView === "thread" ? "hidden lg:block" : ""} flex h-[70vh] flex-col overflow-hidden`}>
          <div className="space-y-2 border-b border-zinc-800 p-3">
            <Input
              placeholder="Pesquisar nome, telefone, empresa ou mensagem..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    filter === f
                      ? "border-gold-500/60 bg-gold-500/10 text-gold-300"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  {FILTER_LABEL[f]}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-zinc-800/60" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  icon="💬"
                  title="Nenhuma conversa aqui"
                  description="Só aparecem conversas de clientes cadastrados. Cadastre o cliente no menu Clientes (ou pela Agenda) e o histórico dele aparece aqui."
                />
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {items.map((c) => {
                  const active = c.id === selectedId;
                  return (
                    <li key={c.id} className="group relative">
                      <button
                        onClick={() => void open(c.id)}
                        className={`w-full px-3 py-3 pr-9 text-left transition-colors hover:bg-zinc-800/40 ${active ? "bg-zinc-800/60" : ""}`}
                      >
                        <div className="flex items-start gap-2">
                          <Avatar name={c.contact.name ?? c.contact.jid} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <p className="truncate text-sm font-medium text-zinc-100">
                                {c.contact.name ?? phoneLabel(c.contact.phone)}
                              </p>
                              <span className="shrink-0 text-[11px] text-zinc-500">{shortTime(c.lastMessageAt)}</span>
                            </div>
                            <p className="truncate text-xs text-zinc-400">{phoneLabel(c.contact.phone)}</p>
                            <p className="mt-0.5 truncate text-sm text-zinc-500">
                              {c.lastMessage?.direction === "OUT" ? "↗ " : ""}
                              {previewBody(c.lastBody ?? c.lastMessage?.body)}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {c.customer && <Badge tone="gold">{c.customer.name}</Badge>}
                              {c.labels.map((l) => (
                                <Badge key={l.id} tone={(l.color as any) ?? "neutral"}>
                                  {l.name}
                                </Badge>
                              ))}
                              {c.status !== "OPEN" && <Badge tone="neutral">{STATUS_LABEL[c.status] ?? c.status}</Badge>}
                            </div>
                          </div>
                          {c.unreadCount > 0 && (
                            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-gold-500 text-[11px] font-semibold text-on-accent">
                              {c.unreadCount}
                            </span>
                          )}
                        </div>
                      </button>
                      {/* Fora do botão da linha: <button> dentro de <button> é HTML inválido
                          e derrubava a hidratação da lista. */}
                      <button
                        onClick={() => {
                          if (confirm("Excluir esta conversa?")) {
                            void (async () => {
                              const res = await fetch(`/api/whatsapp/conversations/${c.id}`, { method: "DELETE" });
                              if (res.ok) {
                                toast("Conversa arquivada.", "success");
                                void loadConversations();
                              } else {
                                const data = await res.json().catch(() => ({}));
                                toast(data.error ?? "Não foi possível excluir a conversa.", "error");
                              }
                            })();
                          }
                        }}
                        className="absolute right-2 top-3 hidden text-zinc-500 hover:text-red-400 group-hover:block"
                        title="Excluir conversa"
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {/* ------------------------------------------------------------- COLUNA 2 */}
        <Card className={`${mobileView === "list" ? "hidden lg:flex" : "flex"} h-[70vh] flex-col overflow-hidden`}>
          <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
            <button className="text-sm text-zinc-400 hover:text-zinc-100 lg:hidden" onClick={() => setMobileView("list")}>
              ← lista
            </button>
            {thread ? (
              <>
                <Avatar name={thread.contact.name ?? thread.contact.jid} big />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-100">{thread.contact.name ?? phoneLabel(thread.contact.phone)}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {phoneLabel(thread.contact.phone)}
                    {thread.contact.masked ? " · protegido pelo WhatsApp" : ""}
                  </p>
                </div>
                {/* Situação e responsável se resolvem aqui, dentro da conversa — era o único
                    controle operacional da coluna lateral, que saiu do painel. */}
                <div className="w-32 shrink-0 sm:w-36">
                  <Select
                    value={thread.status}
                    onChange={(e) => void patchConversation({ status: e.target.value })}
                    aria-label="Situação da conversa"
                    title="Situação da conversa"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s] ?? s}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="hidden w-36 shrink-0 lg:block">
                  <Select
                    value={thread.assigneeId ?? ""}
                    onChange={(e) => void patchConversation({ assigneeId: e.target.value || null })}
                    aria-label="Responsável pela conversa"
                    title="Responsável pelo atendimento"
                  >
                    <option value="">Sem responsável</option>
                    {team.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-500">Selecione uma conversa</p>
            )}
          </div>

          <div ref={scrollBox} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-zinc-950/40 px-4 py-4">
            {loadingThread && !thread ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 w-2/3 animate-pulse rounded-xl bg-zinc-800/60" />
                ))}
              </div>
            ) : !thread ? (
              <div className="text-sm text-zinc-500">Nenhuma conversa aberta.</div>
            ) : (
              byDay.map((group) => (
                <div key={group.day} className="space-y-2">
                  <p className="text-center text-[11px] uppercase tracking-wide text-zinc-600">{group.day}</p>
                  {group.rows.map((m) => (
                    <Bubble key={m.id} message={m} />
                  ))}
                </div>
              ))
            )}
          </div>

          {/* composer (§7) */}
          {thread && (
            <div className="border-t border-zinc-800 p-3">
              {shortcuts.length > 0 && (
                <ul className="mb-2 overflow-hidden rounded-lg border border-zinc-800">
                  {shortcuts.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => setDraft(r.body)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800/60"
                      >
                        <span className="font-mono text-xs text-gold-400">/{r.shortcut}</span>
                        <span className="truncate text-zinc-400">{r.title ?? r.body}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => void pickAttachment(e.target.files?.[0])}
                />
                <Button
                  variant="ghost"
                  className="px-2"
                  title="Anexar imagem, vídeo, áudio ou documento (até 3 MB)"
                  onClick={() => fileInput.current?.click()}
                  disabled={sending || !connected}
                >
                  📎
                </Button>
                <Textarea
                  rows={2}
                  className="max-h-40 flex-1"
                  placeholder="Digite sua mensagem...  Enter envia, Shift+Enter quebra linha"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim() && !sending) void sendMessage(draft.trim());
                    }
                  }}
                />
                <Button onClick={() => void sendMessage(draft.trim())} disabled={!draft.trim() || sending || !connected}>
                  {sending ? "..." : "Enviar"}
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-600">
                As variáveis {"{{nome}}"}, {"{{empresa}}"}, {"{{telefone}}"} e {"{{usuario}}"} são substituídas pelo CRM
                antes de a mensagem sair.
                {!connected && " Conecte o WhatsApp para enviar."}
              </p>
            </div>
          )}
        </Card>
      </div>

      <StuckQueuePanel />

      <WhatsAppConnectionPanel realtime={realtime} onConnection={(v) => setConnected(v.state === "CONNECTED")} />
    </div>
  );
}

/* -------------------------------------------------------------------- pedaços */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex justify-between gap-2 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300">{value}</span>
    </p>
  );
}

/** Chip de indicador do topo (§20). O `hint` vai no title para não poluir a linha. */
function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "amber" | "red" | "gold";
}) {
  const ring =
    tone === "red" ? "border-red-500/40" : tone === "amber" ? "border-amber-500/30" : tone === "gold" ? "border-gold-500/40" : "border-zinc-800";
  const text =
    tone === "red" ? "text-red-300" : tone === "amber" ? "text-amber-300" : tone === "gold" ? "text-gold-300" : "text-zinc-100";
  return (
    <div className={`rounded-lg border ${ring} bg-zinc-900/40 px-3 py-2`} title={hint}>
      <p className={`text-lg font-semibold leading-tight ${text}`}>{value}</p>
      <p className="text-[11px] text-zinc-500">{label}</p>
    </div>
  );
}

function Avatar({ name, big = false }: { name: string; big?: boolean }) {
  const initials = (name ?? "?").replace(/[^A-Za-zÀ-ÿ ]/g, "").trim().slice(0, 2).toUpperCase() || "WA";
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full border border-zinc-700 bg-zinc-800 font-semibold text-gold-400 ${
        big ? "size-9 text-xs" : "size-8 text-[11px]"
      }`}
      title={`Avatar de ${name} (o provedor atual não devolve a foto do contato)`}
    >
      {initials}
    </span>
  );
}

/** Bolha de mensagem (§6) — recebida à esquerda, enviada à direita, com recibo real. */
function Bubble({ message: m }: { message: MessageRow }) {
  const out = m.direction === "OUT";
  const media = m.media ?? [];
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl border px-3 py-2 text-sm sm:max-w-[70%] ${
          out ? "rounded-br-sm border-gold-500/25 bg-gold-500/10 text-zinc-100" : "rounded-bl-sm border-zinc-800 bg-zinc-900 text-zinc-100"
        }`}
      >
        {media.map((md) => (
          <MediaView key={md.id} media={md} />
        ))}
        {previewBody(m.body) !== "(sem texto)" && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {m.templateKey && <p className="mt-1 font-mono text-[11px] text-zinc-500">{m.templateKey}</p>}
        {m.error && <p className="mt-1 text-[11px] text-red-400">{m.error}</p>}
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-zinc-500">
          <span>{shortTime(m.createdAt)}</span>
          {out && <Receipt status={m.status} />}
          <Badge tone={MSG_TONE[m.status] ?? "neutral"}>{MSG_LABEL[m.status] ?? m.status}</Badge>
        </div>
      </div>
    </div>
  );
}

/** Os risquinhos só aparecem com o que o WhatsApp realmente confirmou (§regra de honestidade). */
function Receipt({ status }: { status: string }) {
  if (status === "READ") return <span title="Lida">✓✓</span>;
  if (status === "DELIVERED") return <span title="Entregue">✓✓</span>;
  if (status === "SENT") return <span title="Enviada (servidor aceitou)">✓</span>;
  if (status === "FAILED") return <span className="text-red-400" title="Falhou">!</span>;
  if (status === "QUEUED" || status === "PENDING") return <span title="Na fila">◷</span>;
  return null;
}

function MediaView({ media: md }: { media: MediaRow }) {
  const stored = md.url?.startsWith("data:") ? md.url : null;
  if (!stored) {
    return (
      <p className="mb-1 rounded bg-zinc-800/70 px-2 py-1 text-[11px] text-zinc-400">
        {md.kind === "image" ? "🖼️ imagem" : md.kind === "audio" ? "🎤 áudio" : md.kind === "video" ? "🎬 vídeo" : "📄 documento"}
        {md.fileName ? ` · ${md.fileName}` : ""} — o anexo chegou do WhatsApp e ainda não foi baixado para o CRM.
      </p>
    );
  }
  if (md.kind === "image") return <img src={stored} alt={md.fileName ?? "imagem"} className="mb-1 max-h-64 rounded-lg" />;
  if (md.kind === "video") return <video src={stored} controls className="mb-1 max-h-64 rounded-lg" />;
  if (md.kind === "audio") return <audio src={stored} controls className="mb-1 w-full" />;
  return (
    <a href={stored} download={md.fileName ?? "anexo"} className="mb-1 block rounded bg-zinc-800/70 px-2 py-1 text-[12px] text-gold-400 hover:underline">
      📄 {md.fileName ?? "documento"}
    </a>
  );
}
