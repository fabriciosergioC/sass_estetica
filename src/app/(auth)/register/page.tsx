"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, Field, Input } from "@/components/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormErrors = {
  barbearia?: string;
  name?: string;
  email?: string;
  password?: string;
  adminPassword?: string;
  form?: string;
};

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    barbearia: "",
    name: "",
    email: "",
    password: "",
    phone: "",
    adminPassword: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
    };
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (form.barbearia.trim().length < 2) next.barbearia = "Informe o nome da clínica.";
    if (form.name.trim().length < 2) next.name = "Informe seu nome.";
    if (!EMAIL_RE.test(form.email.trim())) next.email = "Informe um e-mail válido.";
    if (form.password.length < 8) next.password = "A senha precisa ter ao menos 8 caracteres.";
    if (!form.adminPassword) next.adminPassword = "Informe a senha de administrador.";
    return next;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = validate();
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setErrors({});
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          barbearia: form.barbearia.trim(),
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message =
          typeof data?.error === "string"
            ? data.error
            : "Não foi possível criar o cadastro. Tente novamente.";
        if (res.status === 403) setErrors({ adminPassword: message });
        else if (res.status === 409) setErrors({ email: message });
        else setErrors({ form: message });
        return;
      }

      router.push("/app");
      router.refresh();
    } catch {
      setErrors({ form: "Falha de conexão. Verifique sua internet." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md animate-fade-up p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gold-500/10 text-2xl">
            ✨
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Crie sua clínica</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Agenda, clientes e WhatsApp automáticos em minutos
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Nome da clínica" error={errors.barbearia}>
            <Input
              value={form.barbearia}
              onChange={set("barbearia")}
              placeholder="Clínica Bela Essência"
            />
          </Field>
          <Field label="Seu nome" error={errors.name}>
            <Input value={form.name} onChange={set("name")} placeholder="Seu nome" />
          </Field>
          <Field label="E-mail" error={errors.email}>
            <Input
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="voce@email.com"
              autoComplete="email"
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
          <Field label="WhatsApp da clínica" hint="Opcional — pode configurar depois">
            <Input
              value={form.phone}
              onChange={set("phone")}
              placeholder="(11) 99999-9999"
              type="tel"
            />
          </Field>

          <Field
            label="Senha de administrador"
            hint="Obrigatória para liberar a criação de uma nova empresa"
            error={errors.adminPassword}
          >
            <Input
              type="password"
              value={form.adminPassword}
              onChange={set("adminPassword")}
              placeholder="••••••••"
              autoComplete="off"
            />
          </Field>

          {errors.form && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {errors.form}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Criando..." : "Criar minha clínica"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Já possui conta?{" "}
          <Link href="/login" className="font-medium text-gold-400 hover:text-gold-300">
            Entrar
          </Link>
        </p>
      </Card>
    </main>
  );
}
