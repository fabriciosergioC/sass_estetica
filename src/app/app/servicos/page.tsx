"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Field, Input, Select, Textarea, Badge } from "@/components/ui";
import { Dialog } from "@/components/dialog";
import { toast } from "@/components/toast";
import { formatBRL, parseBRLToCents } from "@/lib/format";

type Service = {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  category: string;
  active: boolean;
};

const CATEGORIES = [
  "Estética Facial",
  "Estética Corporal",
  "Sobrancelhas e Cílios",
  "Depilação",
  "Massagens",
  "Tratamentos Especiais",
  "Geral"
];

const emptyForm = { name: "", description: "", durationMin: "30", price: "", category: "Estética Facial" };

export default function ServicosPage() {
  const [items, setItems] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/services?pageSize=100", { cache: 'no-store' });
    const data = await res.json();
    setItems(data.items ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setError("");
    setDialogOpen(true);
  }

  function openEdit(s: Service) {
    setEditing(s);
    setForm({
      name: s.name,
      description: s.description ?? "",
      durationMin: String(s.durationMin),
      price: (s.priceCents / 100).toFixed(2).replace(".", ","),
      category: s.category,
    });
    setError("");
    setDialogOpen(true);
  }

  async function save() {
    setError("");
    const priceCents = parseBRLToCents(form.price);
    if (!form.name.trim()) return setError("Informe o nome do serviço.");
    if (!Number.isFinite(priceCents) || priceCents < 0) return setError("Informe um preço válido.");
    if (Number(form.durationMin) < 5) return setError("Duração mínima: 5 minutos.");

    setSaving(true);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      durationMin: Number(form.durationMin),
      priceCents,
      category: form.category,
    };
    try {
      const res = await fetch(editing ? `/api/services/${editing.id}` : "/api/services", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return setError(data.error ?? "Não foi possível salvar.");
      }
      toast(editing ? "Serviço atualizado." : "Serviço criado.");
      setDialogOpen(false);
      load();
    } catch {
      // Sem isso o botão ficava preso em "Salvando..." se a rede caísse no meio.
      setError("Erro ao conectar com o servidor.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s: Service) {
    const res = await fetch(`/api/services/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !s.active }),
    });
    if (res.ok) {
      toast(s.active ? "Serviço desativado." : "Serviço ativado.");
      load();
    } else {
      toast("Não foi possível alterar.", "error");
    }
  }

  const activeItems = items.filter((s) => s.active);
  const inactiveItems = items.filter((s) => !s.active);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Serviços</h1>
          <p className="mt-1 text-sm text-zinc-500">Catálogo exibido na página de agendamento online.</p>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          <span aria-hidden className="text-base leading-none">＋</span>
          Novo serviço
        </Button>
      </header>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-zinc-900" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="✨"
          title="Nenhum serviço cadastrado"
          description="Cadastre procedimentos, pacotes e combos com duração e preço para começar a agendar."
          action={<Button onClick={openCreate}>Cadastrar primeiro serviço</Button>}
        />
      ) : (
        <div className="space-y-3">
          {[...activeItems, ...inactiveItems].map((s) => (
            <Card key={s.id} className={`animate-fade-up flex flex-wrap items-center gap-3 p-4 ${!s.active ? "opacity-50" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{s.name}</h3>
                  <Badge tone="neutral">{s.category}</Badge>
                  {!s.active && <Badge tone="red">Inativo</Badge>}
                </div>
                {s.description && <p className="mt-0.5 line-clamp-1 text-sm text-zinc-500">{s.description}</p>}
                <p className="mt-1 text-sm text-zinc-400">
                  {s.durationMin} min · <span className="font-medium text-gold-400">{formatBRL(s.priceCents)}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => openEdit(s)}>
                  Editar
                </Button>
                <Button variant="ghost" onClick={() => toggleActive(s)}>
                  {s.active ? "Desativar" : "Ativar"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={editing ? "Editar serviço" : "Novo serviço"}>
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Limpeza de pele" />
          </Field>
          <Field label="Descrição">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Opcional" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duração (min)">
              <Input type="number" min={5} max={480} step={5} value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })} />
            </Field>
            <Field label="Preço (R$)">
              <Input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="45,00" />
            </Field>
          </div>
          <Field label="Categoria">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {/* Rodapé fixo: o botão de salvar continua visível mesmo com o formulário rolando. */}
          <div className="sticky bottom-0 -mx-5 -mb-5 mt-5 flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900/95 px-5 py-3 backdrop-blur">
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Salvando..." : editing ? "Salvar alterações" : "Salvar serviço"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
