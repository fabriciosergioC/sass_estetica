"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Field, Input, Textarea, Select, Badge } from "@/components/ui";
import { toast } from "@/components/toast";
import { WhatsAppConnectionPanel } from "@/components/whatsapp/connection-panel";

type Organization = {
  name: string;
  slug: string;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  instagram: string | null;
  description: string | null;
  primaryColor: string;
  slotStepMin: number;
  settings: { advanceDays?: number; minHoursAhead?: number; allowSameDay?: boolean };
};

type Plan = { code: string; name: string; maxBarbers: number; maxCustomers: number } | null;

type Hour = {
  weekday: number;
  closed: boolean;
  openTime: string;
  closeTime: string;
  breakStart: string | null;
  breakEnd: string | null;
};

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export default function ConfiguracoesPage() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [plan, setPlan] = useState<Plan>(null);
  const [hours, setHours] = useState<Hour[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingHours, setSavingHours] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [orgRes, hoursRes] = await Promise.all([
      fetch("/api/organizations"),
      fetch("/api/business-hours"),
    ]);
    const orgData = await orgRes.json();
    const hoursData = await hoursRes.json();
    setOrg(orgData.organization ?? null);
    setPlan(orgData.plan ?? null);
    setHours(hoursData.hours ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!org) return;
    setSaving(true);
    const res = await fetch("/api/organizations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: org.name,
        phone: org.phone,
        whatsapp: org.whatsapp,
        address: org.address,
        city: org.city,
        state: org.state,
        instagram: org.instagram,
        description: org.description,
        primaryColor: org.primaryColor,
        slotStepMin: org.slotStepMin,
        settings: org.settings,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? "Não foi possível salvar.", "error");
      return;
    }
    toast("Configurações salvas.");
    load();
  }

  async function saveHours() {
    setSavingHours(true);
    const res = await fetch("/api/business-hours", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours }),
    });
    setSavingHours(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error ?? "Não foi possível salvar os horários.", "error");
      return;
    }
    toast("Horários de funcionamento salvos.");
  }

  function updateHour(weekday: number, patch: Partial<Hour>) {
    setHours((prev) => prev.map((h) => (h.weekday === weekday ? { ...h, ...patch } : h)));
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="h-40 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/60" />
        <div className="h-64 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/60" />
      </div>
    );
  }

  if (!org) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card className="p-5 text-sm text-zinc-500">
          Não foi possível carregar as configurações. Recarregue a página.
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Dados da clínica, aparência da página pública e horários.
        </p>
      </header>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Identidade</h2>
          <Badge tone="gold">Plano {plan?.name ?? "—"}</Badge>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Nome da clínica">
            <Input value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} />
          </Field>
          <Field label="Página pública" hint={`/b/${org.slug}`}>
            <Input value={`/b/${org.slug}`} disabled />
          </Field>
          <Field label="Telefone">
            <Input
              value={org.phone ?? ""}
              onChange={(e) => setOrg({ ...org, phone: e.target.value || null })}
            />
          </Field>
          <Field label="WhatsApp">
            <Input
              value={org.whatsapp ?? ""}
              onChange={(e) => setOrg({ ...org, whatsapp: e.target.value || null })}
            />
          </Field>
          <Field label="Instagram">
            <Input
              value={org.instagram ?? ""}
              onChange={(e) => setOrg({ ...org, instagram: e.target.value || null })}
            />
          </Field>
          <Field label="Cor principal" hint="Formato #rrggbb">
            <div className="flex gap-2">
              <input
                type="color"
                value={org.primaryColor}
                onChange={(e) => setOrg({ ...org, primaryColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-zinc-700 bg-zinc-900"
              />
              <Input
                value={org.primaryColor}
                onChange={(e) => setOrg({ ...org, primaryColor: e.target.value })}
              />
            </div>
          </Field>
          <Field label="Endereço">
            <Input
              value={org.address ?? ""}
              onChange={(e) => setOrg({ ...org, address: e.target.value || null })}
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Cidade">
              <Input
                value={org.city ?? ""}
                onChange={(e) => setOrg({ ...org, city: e.target.value || null })}
              />
            </Field>
            <Field label="UF">
              <Input
                maxLength={2}
                value={org.state ?? ""}
                onChange={(e) => setOrg({ ...org, state: e.target.value.toUpperCase() || null })}
              />
            </Field>
            <Field label="Passo (min)">
              <Input
                type="number"
                min={5}
                max={120}
                value={org.slotStepMin}
                onChange={(e) => setOrg({ ...org, slotStepMin: Number(e.target.value) })}
              />
            </Field>
          </div>
        </div>
        <Field label="Descrição">
          <Textarea
            className="mt-4"
            value={org.description ?? ""}
            onChange={(e) => setOrg({ ...org, description: e.target.value || null })}
          />
        </Field>
        <div className="mt-4 flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </Card>

      {/* §2: a conexão do WhatsApp mora em Configurações. O MESMO painel aparece no rodapé da
          tela de conversas — por isso ele é um componente à parte e não código copiado. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-medium">WhatsApp</h2>
            <p className="text-sm text-zinc-500">Pareamento, provedor e teste de conexão.</p>
          </div>
          <Link
            href="/app/whatsapp"
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-gold-400 hover:bg-zinc-800/60"
          >
            Abrir conversas →
          </Link>
        </div>
        <WhatsAppConnectionPanel />
      </section>

      <Card className="p-5">
        <h2 className="font-medium">Agendamento online</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Antecedência (dias)">
            <Input
              type="number"
              min={1}
              max={60}
              value={org.settings.advanceDays ?? 14}
              onChange={(e) =>
                setOrg({ ...org, settings: { ...org.settings, advanceDays: Number(e.target.value) } })
              }
            />
          </Field>
          <Field label="Mín. horas na frente">
            <Input
              type="number"
              min={0}
              max={72}
              value={org.settings.minHoursAhead ?? 0}
              onChange={(e) =>
                setOrg({ ...org, settings: { ...org.settings, minHoursAhead: Number(e.target.value) } })
              }
            />
          </Field>
          <Field label="Permite mesmo dia">
            <Select
              value={org.settings.allowSameDay === false ? "no" : "yes"}
              onChange={(e) =>
                setOrg({
                  ...org,
                  settings: { ...org.settings, allowSameDay: e.target.value === "yes" },
                })
              }
            >
              <option value="yes">Sim</option>
              <option value="no">Não</option>
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? "Salvando..." : "Salvar alterações"}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-medium">Horários de funcionamento (padrão)</h2>
        <div className="mt-4 space-y-2">
          {hours.map((h) => (
            <div
              key={h.weekday}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
            >
              <span className="w-20 text-sm text-zinc-300">{WEEKDAYS[h.weekday]}</span>
              <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={h.closed}
                  onChange={(e) => updateHour(h.weekday, { closed: e.target.checked })}
                  className="accent-red-500"
                />
                Fechado
              </label>
              {!h.closed && (
                <>
                  <Input
                    type="time"
                    className="w-28"
                    value={h.openTime}
                    onChange={(e) => updateHour(h.weekday, { openTime: e.target.value })}
                  />
                  <span className="text-zinc-600">até</span>
                  <Input
                    type="time"
                    className="w-28"
                    value={h.closeTime}
                    onChange={(e) => updateHour(h.weekday, { closeTime: e.target.value })}
                  />
                  <span className="text-xs text-zinc-600">intervalo</span>
                  <Input
                    type="time"
                    className="w-28"
                    value={h.breakStart ?? ""}
                    onChange={(e) => updateHour(h.weekday, { breakStart: e.target.value || null })}
                  />
                  <Input
                    type="time"
                    className="w-28"
                    value={h.breakEnd ?? ""}
                    onChange={(e) => updateHour(h.weekday, { breakEnd: e.target.value || null })}
                  />
                </>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={saveHours} disabled={savingHours}>
            {savingHours ? "Salvando..." : "Salvar horários"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
