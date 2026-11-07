"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Field, Input, Badge } from "@/components/ui";
import { Dialog } from "@/components/dialog";
import { toast } from "@/components/toast";

type Barber = {
  id: string;
  name: string;
  bio: string | null;
  specialties: string;
  commissionPct: number;
  active: boolean;
  services: { id: string; name: string }[];
};

type ServiceOption = { id: string; name: string; active: boolean };

const emptyForm = { name: "", bio: "", specialties: "", commissionPct: "0", serviceIds: [] as string[] };

export default function BarbeirosPage() {
  const [items, setItems] = useState<Barber[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Barber | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [barbersRes, servicesRes] = await Promise.all([
      fetch("/api/barbers?pageSize=100"),
      fetch("/api/services?pageSize=100"),
    ]);
    const barbersData = await barbersRes.json();
    const servicesData = await servicesRes.json();
    setItems(barbersData.items ?? []);
    setServices((servicesData.items ?? []).map((s: ServiceOption) => ({ id: s.id, name: s.name, active: s.active })));
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

  function openEdit(b: Barber) {
    setEditing(b);
    setForm({
      name: b.name,
      bio: b.bio ?? "",
      specialties: b.specialties,
      commissionPct: String(b.commissionPct),
      serviceIds: b.services.map((s) => s.id),
    });
    setError("");
    setDialogOpen(true);
  }

  function toggleService(id: string) {
    setForm((f) => ({
      ...f,
      serviceIds: f.serviceIds.includes(id) ? f.serviceIds.filter((s) => s !== id) : [...f.serviceIds, id],
    }));
  }

  async function save() {
    setError("");
    if (form.name.trim().length < 2) return setError("Informe o nome do atendente.");
    const pct = Number(form.commissionPct);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return setError("Comissão deve ser de 0 a 100.");

    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        bio: form.bio.trim() || undefined,
        specialties: form.specialties.trim(),
        commissionPct: pct,
        serviceIds: form.serviceIds,
      };
      const res = await fetch(editing ? `/api/barbers/${editing.id}` : "/api/barbers", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return setError(data.error ?? "Não foi possível salvar.");
      }
      toast(editing ? "Atendente atualizado." : "Atendente cadastrado.");
      setDialogOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(b: Barber) {
    const res = await fetch(`/api/barbers/${b.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !b.active }),
    });
    if (res.ok) {
      toast(b.active ? "Atendente desativado." : "Atendente ativado.");
      load();
    } else {
      toast("Não foi possível alterar.", "error");
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Atendentes</h1>
          <p className="mt-1 text-sm text-zinc-500">Equipe, especialidades e serviços que cada um executa.</p>
        </div>
        <Button onClick={openCreate}>+ Novo atendente</Button>
      </header>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-zinc-900" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="✨"
          title="Nenhum atendente cadastrado"
          description="Cadastre sua equipe para que clientes possam escolher com quem querem ser atendidos."
          action={<Button onClick={openCreate}>Cadastrar primeiro atendente</Button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((b) => (
            <Card key={b.id} className={`animate-fade-up p-4 ${!b.active ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gold-500/15 text-lg font-semibold text-gold-400">
                    {b.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-medium">{b.name}</h3>
                    <p className="text-xs text-zinc-500">
                      Comissão {b.commissionPct}%{b.specialties ? ` · ${b.specialties}` : ""}
                    </p>
                  </div>
                </div>
                {!b.active && <Badge tone="red">Inativo</Badge>}
              </div>
              {b.bio && <p className="mt-2 line-clamp-2 text-sm text-zinc-500">{b.bio}</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                {b.services.length === 0 ? (
                  <span className="text-xs text-zinc-600">Nenhum serviço atribuído</span>
                ) : (
                  b.services.map((s) => (
                    <Badge key={s.id} tone="neutral">
                      {s.name}
                    </Badge>
                  ))
                )}
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" onClick={() => openEdit(b)}>
                  Editar
                </Button>
                <Button variant="ghost" onClick={() => toggleActive(b)}>
                  {b.active ? "Desativar" : "Ativar"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={editing ? "Editar atendente" : "Novo atendente"}>
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Carlos Silva" />
          </Field>
          <Field label="Especialidades">
            <Input value={form.specialties} onChange={(e) => setForm({ ...form, specialties: e.target.value })} placeholder="Facial, massagem, depilação" />
          </Field>
          <Field label="Bio">
            <Input value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Opcional — aparece na página pública" />
          </Field>
          <Field label="Comissão (%)">
            <Input type="number" min={0} max={100} value={form.commissionPct} onChange={(e) => setForm({ ...form, commissionPct: e.target.value })} />
          </Field>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Serviços que executa</p>
            {services.length === 0 ? (
              <p className="text-sm text-zinc-500">Cadastre serviços primeiro.</p>
            ) : (
              <div className="grid max-h-44 grid-cols-1 gap-1.5 overflow-y-auto rounded-lg border border-zinc-800 p-2 sm:grid-cols-2">
                {services.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-zinc-300 hover:bg-zinc-800/60">
                    <input
                      type="checkbox"
                      checked={form.serviceIds.includes(s.id)}
                      onChange={() => toggleService(s.id)}
                      className="h-4 w-4 accent-gold-500"
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
