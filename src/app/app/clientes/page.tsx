"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, Field, Input, Badge } from "@/components/ui";
import { Dialog } from "@/components/dialog";
import { toast } from "@/components/toast";
import { formatPhone, SEGMENT_META } from "@/lib/format";
import { can } from "@/lib/auth/permissions";

type Metrics = { segment: string; visits: number; avgIntervalDays: number | null } | null;

type Customer = {
  id: string;
  name: string;
  phone: string;
  whatsappOptIn: boolean;
  metrics: Metrics;
};

const SEGMENT_FILTERS = [
  { value: "", label: "Todos" },
  { value: "NEW", label: "Novos" },
  { value: "RECURRENT", label: "Recorrentes" },
  { value: "VIP", label: "VIP" },
  { value: "RETURN_DUE", label: "Retorno devido" },
  { value: "INACTIVE", label: "Inativos" },
];

export default function ClientesPage() {
  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [segment, setSegment] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", birthday: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ id: string; name: string } | null>(null);
  /** Papel vindo da sessão real. A permissão de fato é conferida no backend; aqui só evita
   *  mostrar um botão de excluir que ia dar erro na cara de quem não pode usar. */
  const [role, setRole] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (query: string, seg: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: "50" });
      if (query) params.set("q", query);
      if (seg) params.set("segment", seg);
      const res = await fetch(`/api/customers?${params}`);
      // O dev server do Next já devolveu página de erro em HTML uma vez; sem o catch o
      // JSON.parse arrebentava aqui e a lista ficava presa no esqueleto de carregando.
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível carregar os clientes.", "error");
        return;
      }
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch {
      toast("Não foi possível carregar os clientes. Tente novamente.", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q, segment), 250);
    return () => clearTimeout(t);
  }, [q, segment, load]);

  useEffect(() => {
    void (async () => {
      // cache: no-store porque trocar de barbearia muda o papel na mesma URL.
      const d = await fetch("/api/auth/session", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => ({}));
      setRole(d?.session?.role ?? null);
    })();
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", phone: "", birthday: "", notes: "" });
    setError("");
    setConflict(null);
    setDialogOpen(true);
  }

  function openEdit(c: Customer) {
    setEditing(c);
    setForm({ name: c.name, phone: c.phone, birthday: "", notes: "" });
    setError("");
    setConflict(null);
    setDialogOpen(true);
  }

  /**
   * Mostra o erro do servidor. Quando é número repetido, guardamos o dono do número para o
   * link "abrir cliente" — a pessoa quer editar o cadastro que já existe, não criar outro.
   */
  function showFailure(res: Response, data: { error?: string; conflict?: { id: string; name: string } }) {
    setConflict(res.status === 409 && data.conflict ? data.conflict : null);
    setError(data.error ?? (res.status === 409 ? "Este número de WhatsApp já está cadastrado." : "Não foi possível salvar."));
  }

  async function save() {
    setError("");
    setConflict(null);
    if (form.name.trim().length < 2) {
      return setError("Informe o nome.");
    }
    if (form.phone.replace(/\D/g, "").length < 10) {
      return setError("Informe um telefone válido com DDD.");
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone,
        birthday: form.birthday || undefined,
        notes: form.notes.trim() || undefined,
      };
      const res = await fetch(editing ? `/api/customers/${editing.id}` : "/api/customers", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showFailure(res, data);

      toast(editing ? "Cliente atualizado." : "Cliente cadastrado.");
      // Sucesso: fecha o modal e atualiza a lista
      setEditing(null);
      setDialogOpen(false);
      setForm({ name: "", phone: "", birthday: "", notes: "" });
      load(q, segment);
    } catch (e) {
      setError("Erro ao conectar com o servidor.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Excluir chama o DELETE que já existia no backend, só que agora alcançável pela tela.
   * Cliente com agendamento não some: a rota anonimiza (LGPD — o histórico continua batendo).
   * Cliente sem agendamento é removido de verdade.
   */
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/customers/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível excluir o cliente.", "error");
        return;
      }
      toast(
        data.anonymized ? "Dados pessoais removidos. As visitas ficam no histórico." : "Cliente excluído."
      );
      setDeleteTarget(null);
      await load(q, segment);
    } catch {
      toast("Erro ao conectar com o servidor.", "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {total > 0 ? `${total} cliente(s) cadastrado(s).` : "Nenhum cliente cadastrado ainda."}{" "}
            <span className="text-zinc-600">Um número de WhatsApp por cliente.</span>
          </p>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          <span aria-hidden className="text-base leading-none">＋</span>
          Novo cliente
        </Button>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nome ou telefone..."
          className="sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-1.5">
          {SEGMENT_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setSegment(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                segment === f.value
                  ? "border-gold-500/60 bg-gold-500/10 text-gold-300"
                  : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-900" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="👥"
          title={q || segment ? "Nenhum cliente encontrado" : "Nenhum cliente cadastrado"}
          description={q || segment ? "Tente outra busca ou filtro." : "Clientes cadastrados aqui aparecem no agendamento e no CRM."}
          action={
            !q && !segment ? <Button onClick={openCreate}>Cadastrar primeiro cliente</Button> : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {items.map((c) => (
            <Link key={c.id} href={`/app/clientes/${c.id}`} className="block">
              <Card className="animate-fade-up relative flex flex-wrap items-center gap-3 p-4 transition-colors hover:border-gold-500/40">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-300">
                  {c.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-medium">{c.name}</h3>
                    {c.metrics && (
                      <Badge tone={SEGMENT_META[c.metrics.segment]?.tone ?? "neutral"}>
                        {SEGMENT_META[c.metrics.segment]?.label ?? c.metrics.segment}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-zinc-500">{formatPhone(c.phone)}</p>
                </div>
                <div className="shrink-0 self-center text-right text-xs text-zinc-500">
                  <p>{c.metrics ? `${c.metrics.visits} visitas` : "\u00A0"}</p>
                  {c.metrics?.avgIntervalDays != null && <p>ciclo ~{c.metrics.avgIntervalDays}d</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1 self-start">
                  <Button variant="ghost" onClick={(e) => { e.preventDefault(); openEdit(c); }}>
                    Editar
                  </Button>
                  {can(role ?? undefined, "customers:delete") && (
                    /* Botão simples, fora do Button: <a> já envolve a linha inteira, então
                       precisa do e.preventDefault() para não navegar para a ficha. */
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        setDeleteTarget(c);
                      }}
                      className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                      title="Excluir cliente"
                    >
                      Excluir
                    </button>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={editing ? "Editar cliente" : "Novo cliente"}>
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="João Pereira" />
          </Field>
          <Field label="WhatsApp / Telefone" hint="Com DDD. Ex: (11) 98765-4321">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(11) 98765-4321" inputMode="tel" />
          </Field>
          <Field label="Nascimento">
            <Input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
          </Field>
          <Field label="Observações">
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Preferências, alergias..." />
          </Field>
          {error && <p className="text-sm font-medium text-red-400">{error}</p>}
          {conflict && (
            <Link
              href={`/app/clientes/${conflict.id}`}
              onClick={() => setDialogOpen(false)}
              className="block text-sm text-gold-400 hover:underline"
            >
              Abrir {conflict.name} →
            </Link>
          )}
          {/* Rodapé fixo: em tela de celular o formulário passa da dobra, e o botão de salvar
              precisa continuar visível enquanto os dados estão sendo digitados. */}
          <div className="sticky bottom-0 -mx-5 -mb-5 mt-5 flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 backdrop-blur">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Salvando..." : editing ? "Salvar alterações" : "Salvar cliente"}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Excluir sempre passa por aqui: é a única ação da tela que apaga dado de gente. */}
      <Dialog
        open={!!deleteTarget}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title="Excluir cliente"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <p className="truncate text-sm font-medium text-zinc-100">{deleteTarget?.name}</p>
            <p className="text-xs text-zinc-500">{formatPhone(deleteTarget?.phone ?? "")}</p>
          </div>
          <p className="text-sm text-zinc-400">
            {(deleteTarget?.metrics?.visits ?? 0) > 0
              ? "Este cliente tem agendamentos no histórico, então o CRM apaga nome, telefone e observações e mantém o registro vazio — é assim que os relatórios continuam batendo. As conversas de WhatsApp seguem salvas."
              : "Este cliente não tem agendamentos: o cadastro é removido inteiro, junto das observações e das métricas. Mensagens de WhatsApp continuam existindo, só deixam de aparecer ligadas a ele."}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Excluindo..." : "Excluir de vez"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
