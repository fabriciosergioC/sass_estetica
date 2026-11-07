"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Badge, Textarea, Field, Input, Select } from "@/components/ui";
import { Dialog } from "@/components/dialog";
import { toast } from "@/components/toast";
import { formatPhone } from "@/lib/format";

type Rule = {
  id: string;
  event: string;
  action: string;
  config: { template?: string; hoursBefore?: number; delayMinutes?: number; title?: string };
  enabled: boolean;
};

type Template = { id: string; key: string; name: string; body: string; enabled: boolean };
type Execution = {
  id: string;
  event: string;
  status: string;
  error: string | null;
  createdAt: string;
};

const EVENT_LABEL: Record<string, string> = {
  "appointment.created": "Agendamento criado",
  "appointment.confirmed": "Agendamento confirmado",
  "appointment.cancelled": "Agendamento cancelado",
  "appointment.rescheduled": "Agendamento remarcado",
  "appointment.completed": "Atendimento concluído",
  "appointment.no_show": "Cliente faltou",
  "customer.created": "Novo cliente",
  "customer.inactive": "Cliente inativo",
  "customer.return_due": "Retorno devido",
  "slot.opened": "Horário liberado",
};

const ACTION_LABEL: Record<string, string> = {
  send_whatsapp: "Enviar WhatsApp",
  schedule_reminder: "Agendar lembrete",
  notify_admin: "Notificar admin",
  create_opportunity: "Criar oportunidade",
  create_task: "Criar tarefa",
  update_customer: "Atualizar cliente",
};

type DispatchTarget = {
  open: boolean;
  templateKey?: string;
  ruleId?: string;
};

export default function AutomacoesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");

  const [dispatchTarget, setDispatchTarget] = useState<DispatchTarget>({ open: false });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/automations");
    const data = await res.json();
    setRules(data.rules ?? []);
    setTemplates(data.templates ?? []);
    setExecutions(data.executions ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(rule: Rule) {
    const res = await fetch("/api/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rule.id, enabled: !rule.enabled }),
    });
    if (!res.ok) {
      toast("Não foi possível atualizar a regra.", "error");
      return;
    }
    toast(rule.enabled ? "Regra desativada." : "Regra ativada.");
    load();
  }

  function startEdit(t: Template) {
    setEditing(t);
    setDraft(t.body);
  }

  async function saveTemplate() {
    if (!editing) return;
    setSaving(true);
    const res = await fetch("/api/automations/templates", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: editing.key, body: draft }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error ?? "Não foi possível salvar.", "error");
      return;
    }
    toast("Template salvo.");
    setEditing(null);
    load();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automações</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Regras disparadas por eventos da agenda e mensagens automáticas via WhatsApp.
          </p>
        </div>
        <Button onClick={() => setDispatchTarget({ open: true })}>
          📤 Disparar para cliente
        </Button>
      </header>

      {loading ? (
        <div className="h-40 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/60" />
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 className="font-medium">Regras</h2>
              <p className="text-xs text-zinc-500">Ative, desative ou faça envio manual de cada automação.</p>
            </div>
            {rules.length === 0 ? (
              <EmptyState
                icon="⚡"
                title="Nenhuma regra configurada"
                description="Novas clínicas recebem regras padrão de confirmação e lembrete."
              />
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {rules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-200">
                        {EVENT_LABEL[rule.event] ?? rule.event}
                        <span className="ml-2 text-zinc-500">→</span>
                        <span className="ml-2 text-gold-300">
                          {ACTION_LABEL[rule.action] ?? rule.action}
                          {/* O nome do template em vez da chave crua (`reminder_24h`): é assim que
                              ele confere, na tela, que os dois lembretes estão ligados. */}
                          {rule.config.template
                            ? ` (${templates.find((t) => t.key === rule.config.template)?.name ?? rule.config.template})`
                            : ""}
                          {rule.config.hoursBefore ? ` · ${rule.config.hoursBefore}h antes` : ""}
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {rule.config.template && (
                        <Button
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          onClick={() =>
                            setDispatchTarget({
                              open: true,
                              templateKey: rule.config.template,
                              ruleId: rule.id,
                            })
                          }
                          title="Enviar esta automação manualmente para um cliente específico"
                        >
                          Disparar
                        </Button>
                      )}
                      <button
                        onClick={() => toggle(rule)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                          rule.enabled ? "bg-gold-500" : "bg-zinc-700"
                        }`}
                        aria-label={rule.enabled ? "Desativar" : "Ativar"}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-zinc-950 transition-all ${
                            rule.enabled ? "left-[22px]" : "left-0.5"
                          }`}
                        />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 className="font-medium">Mensagens (templates)</h2>
              <p className="text-xs text-zinc-500">
                Variáveis: {"{{cliente}} {{data}} {{hora}} {{barbearia}} {{servico}} {{barbeiro}}"}
              </p>
            </div>
            <ul className="divide-y divide-zinc-800/60">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-200">
                      {t.name} <span className="text-xs text-zinc-600">({t.key})</span>
                      {!t.enabled && <span className="ml-2"><Badge tone="red">desativado</Badge></span>}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{t.body}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      className="px-3 py-1.5 text-xs text-gold-400 hover:text-gold-300"
                      onClick={() => setDispatchTarget({ open: true, templateKey: t.key })}
                      title="Disparar esta mensagem para um cliente específico"
                    >
                      📤 Disparar
                    </Button>
                    <Button variant="outline" className="px-3 py-1.5 text-xs" onClick={() => startEdit(t)}>
                      Editar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-zinc-800 px-5 py-4">
              <h2 className="font-medium">Execuções recentes</h2>
            </div>
            {executions.length === 0 ? (
              <p className="px-5 py-6 text-sm text-zinc-500">
                Nenhuma execução registrada ainda. Elas aparecem aqui quando os eventos dispararem ou após disparos manuais.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {executions.map((ex) => (
                  <li key={ex.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                    <span className="text-zinc-300">{EVENT_LABEL[ex.event] ?? ex.event}</span>
                    <span className="flex items-center gap-2">
                      {ex.error && (
                        <span
                          className={`max-w-xs truncate text-xs ${
                            ex.status === "SKIPPED" ? "text-zinc-500" : "text-red-400"
                          }`}
                          title={ex.error}
                        >
                          {ex.error}
                        </span>
                      )}
                      <Badge
                        tone={
                          ex.status === "SUCCESS"
                            ? "green"
                            : ex.status === "FAILED"
                              ? "red"
                              : ex.status === "SKIPPED"
                                ? "neutral"
                                : "amber"
                        }
                      >
                        {ex.status}
                      </Badge>
                      <span className="text-xs text-zinc-600">
                        {new Date(ex.createdAt).toLocaleString("pt-BR")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {/* Modal de Edição de Template */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card className="w-full max-w-lg p-5">
            <h3 className="font-medium">Editar: {editing.name}</h3>
            <Textarea
              className="mt-3 min-h-32"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
              <Button onClick={saveTemplate} disabled={saving}>
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Modal de Disparo Manual de Automação para um Cliente */}
      <ManualDispatchDialog
        open={dispatchTarget.open}
        onClose={() => setDispatchTarget({ open: false })}
        templates={templates}
        initialTemplateKey={dispatchTarget.templateKey}
        initialRuleId={dispatchTarget.ruleId}
        onDispatched={load}
      />
    </div>
  );
}

function ManualDispatchDialog({
  open,
  onClose,
  templates,
  initialTemplateKey,
  initialRuleId,
  onDispatched,
}: {
  open: boolean;
  onClose: () => void;
  templates: Template[];
  initialTemplateKey?: string;
  initialRuleId?: string;
  onDispatched: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState(initialTemplateKey || templates[0]?.key || "");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState<Array<{ id: string; name: string; phone: string; whatsappOptIn: boolean }>>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; name: string; phone: string; whatsappOptIn: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [customBody, setCustomBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedCustomer(null);
      setCustomerQuery("");
      setCustomers([]);
      return;
    }
    const key = initialTemplateKey || templates[0]?.key || "";
    setSelectedKey(key);
    const t = templates.find((x) => x.key === key);
    if (t) setCustomBody(t.body);
  }, [open, initialTemplateKey, templates]);

  useEffect(() => {
    const t = templates.find((x) => x.key === selectedKey);
    if (t) setCustomBody(t.body);
  }, [selectedKey, templates]);

  useEffect(() => {
    if (!open || customerQuery.trim().length < 2) {
      setCustomers([]);
      return;
    }
    setSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(customerQuery.trim())}&pageSize=6`);
        const data = await res.json().catch(() => ({}));
        setCustomers(data.items ?? []);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [customerQuery, open]);

  async function handleSend() {
    if (!selectedCustomer) {
      toast("Selecione um cliente para disparar.", "error");
      return;
    }
    if (!selectedCustomer.phone) {
      toast("O cliente selecionado não tem telefone cadastrado.", "error");
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/automations/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          templateKey: selectedKey,
          ruleId: initialRuleId,
          customBody,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        toast(data.friendly || data.error || "Não foi possível disparar a mensagem.", "error");
        return;
      }
      toast(data.friendly || "Mensagem disparada com sucesso via WhatsApp!");
      onDispatched();
      onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Disparo manual de mensagem" wide>
      <div className="space-y-4 pt-1">
        <p className="text-sm text-zinc-400">
          Envie imediatamente uma mensagem de automação para um cliente específico pelo WhatsApp.
        </p>

        {/* 1. Seleção do Template */}
        <Field label="Opção de automação (template)">
          <Select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)}>
            {templates.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name} ({t.key})
              </option>
            ))}
          </Select>
        </Field>

        {/* 2. Seleção do Cliente */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400">
            Cliente destinatário
          </label>
          {selectedCustomer ? (
            <div className="flex items-center justify-between rounded-lg border border-gold-500/40 bg-gold-500/10 p-3">
              <div>
                <p className="text-sm font-semibold text-zinc-100">{selectedCustomer.name}</p>
                <p className="text-xs text-zinc-400">
                  {selectedCustomer.phone ? formatPhone(selectedCustomer.phone) : "Sem telefone"}
                  {selectedCustomer.whatsappOptIn === false && (
                    <span className="ml-2 font-medium text-red-400">(opt-out WhatsApp)</span>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                className="text-xs text-zinc-400 hover:text-zinc-100"
                onClick={() => {
                  setSelectedCustomer(null);
                  setCustomerQuery("");
                }}
              >
                Trocar cliente
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                placeholder="Buscar cliente por nome ou telefone..."
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                autoFocus
              />
              {searching && <p className="text-xs text-zinc-500">Buscando clientes...</p>}
              {customers.length > 0 && (
                <ul className="max-h-48 divide-y divide-zinc-800/60 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/80">
                  {customers.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCustomer(c);
                          setCustomers([]);
                          setCustomerQuery("");
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800/70"
                      >
                        <div>
                          <p className="font-medium text-zinc-200">{c.name}</p>
                          <p className="text-xs text-zinc-400">
                            {c.phone ? formatPhone(c.phone) : "Sem telefone cadastrado"}
                          </p>
                        </div>
                        {c.whatsappOptIn === false ? (
                          <Badge tone="red">opt-out</Badge>
                        ) : c.phone ? (
                          <span className="text-xs text-gold-400">Selecionar →</span>
                        ) : (
                          <Badge tone="neutral">sem telefone</Badge>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* 3. Texto da Mensagem */}
        <Field
          label="Texto da mensagem"
          hint="Variáveis como {{cliente}}, {{barbearia}}, {{servico}}, {{barbeiro}}, {{data}} e {{hora}} são substituídas automaticamente."
        >
          <Textarea
            rows={4}
            value={customBody}
            onChange={(e) => setCustomBody(e.target.value)}
            placeholder="Texto da mensagem..."
          />
        </Field>

        {/* 4. Ações */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 pt-3">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancelar
          </Button>
          <Button
            onClick={handleSend}
            disabled={
              !selectedCustomer ||
              !selectedCustomer.phone ||
              selectedCustomer.whatsappOptIn === false ||
              !customBody.trim() ||
              sending
            }
          >
            {sending ? "Disparando..." : "Disparar via WhatsApp"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
