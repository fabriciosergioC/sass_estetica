"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";
import { toast } from "@/components/toast";

type Role = "ADMIN" | "MANAGER" | "RECEPTIONIST" | "BARBER";

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  isSuperAdmin: boolean;
  role: Role;
  status: string;
  createdAt: string;
};

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrador",
  MANAGER: "Gerente",
  RECEPTIONIST: "Recepção",
  BARBER: "Atendente",
};

type FormErrors = {
  name?: string;
  email?: string;
  password?: string;
  form?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function UsuariosPage() {
  const [items, setItems] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [role, setRole] = useState<Role>("RECEPTIONIST");
  const [errors, setErrors] = useState<FormErrors>({});
  // E-mail que já tem login: em vez de erro seco, oferecemos vincular a pessoa à clínica.
  const [existingUser, setExistingUser] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/team", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível carregar os usuários.", "error");
        return;
      }
      setItems(data.items ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
      setExistingUser(null);
    };
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (form.name.trim().length < 2) next.name = "Informe o nome.";
    if (!EMAIL_RE.test(form.email.trim())) next.email = "Informe um e-mail válido.";
    if (form.password.length < 8) next.password = "A senha precisa ter ao menos 8 caracteres.";
    return next;
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    const next = validate();
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setSaving(true);
    setErrors({});
    setExistingUser(null);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 409 && data?.existingUser) {
          setExistingUser(data.existingUser);
          setErrors({ email: data.error ?? "Este e-mail já tem login." });
          return;
        }
        setErrors({ form: data.error ?? "Não foi possível criar o usuário." });
        return;
      }

      toast("Usuário criado.");
      setForm({ name: "", email: "", password: "" });
      setItems((prev) => [...prev, data.item]);
    } catch {
      setErrors({ form: "Falha de conexão. Tente novamente." });
    } finally {
      setSaving(false);
    }
  }

  async function linkUser() {
    if (!existingUser || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: existingUser.id, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors({ form: data.error ?? "Não foi possível dar acesso." });
        return;
      }
      toast("Acesso liberado.");
      setExistingUser(null);
      setForm({ name: "", email: "", password: "" });
      setItems((prev) => [...prev, data.item]);
    } catch {
      setErrors({ form: "Falha de conexão. Tente novamente." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Usuários</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Logins que acessam esta clínica. Cada pessoa entra com o próprio e-mail e senha.
        </p>
      </header>

      <Card className="p-5">
        <h2 className="font-medium">Novo usuário</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Se o e-mail já tiver login na plataforma, oferecemos só dar acesso a esta clínica — a
          senha da pessoa não muda.
        </p>

        <form onSubmit={createUser} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Nome" error={errors.name}>
            <Input value={form.name} onChange={set("name")} placeholder="Nome da pessoa" />
          </Field>
          <Field label="E-mail" error={errors.email}>
            <Input
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="pessoa@email.com"
              autoComplete="off"
            />
          </Field>
          <Field label="Senha" hint="Mínimo de 8 caracteres" error={errors.password}>
            <Input
              type="password"
              value={form.password}
              onChange={set("password")}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Papel">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="ADMIN">Administrador</option>
              <option value="MANAGER">Gerente</option>
              <option value="RECEPTIONIST">Recepção</option>
              <option value="BARBER">Atendente</option>
            </Select>
          </Field>

          {existingUser && (
            <div className="sm:col-span-2 rounded-lg border border-gold-500/40 bg-gold-500/5 p-3">
              <p className="text-sm text-zinc-300">
                <strong className="font-medium text-gold-300">{existingUser.name}</strong> já tem
                login na plataforma. Dar acesso a esta clínica como{" "}
                {ROLE_LABEL[role].toLowerCase()}?
              </p>
              <Button
                type="button"
                variant="secondary"
                className="mt-2"
                onClick={linkUser}
                disabled={saving}
              >
                {saving ? "Liberando..." : "Dar acesso a esta clínica"}
              </Button>
            </div>
          )}

          {errors.form && (
            <p className="sm:col-span-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {errors.form}
            </p>
          )}

          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? "Criando..." : "Criar usuário"}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Quem tem acesso</h2>
          <Button variant="ghost" onClick={load} disabled={loading}>
            {loading ? "Atualizando..." : "Atualizar"}
          </Button>
        </div>

        {!loading && items.length === 0 && (
          <p className="mt-4 text-sm text-zinc-500">Nenhum usuário ainda.</p>
        )}

        {items.length > 0 && (
          <div className="mt-4 divide-y divide-zinc-800">
            {items.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 truncate text-sm text-zinc-200">
                    {m.name}
                    <Badge tone={m.role === "ADMIN" ? "gold" : "neutral"}>
                      {ROLE_LABEL[m.role] ?? m.role}
                    </Badge>
                    {m.status !== "ACTIVE" && <Badge tone="amber">{m.status}</Badge>}
                    {m.isSuperAdmin && <Badge tone="blue">plataforma</Badge>}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">{m.email}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
