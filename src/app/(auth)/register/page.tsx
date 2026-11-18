"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Field, Input } from "@/components/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Regra do cadastro de clínica: a tela sempre começa em branco. Nada da conta ou da clínica
 * que já está logada no navegador é reaproveitado — nem pelo estado do React, nem pelo
 * preenchimento automático do navegador.
 */
const EMPTY_FORM = {
  clinicName: "",
  name: "",
  email: "",
  password: "",
  phone: "",
  adminToken: "",
};

type FormErrors = {
  clinicName?: string;
  name?: string;
  email?: string;
  phone?: string;
  password?: string;
  adminToken?: string;
  form?: string;
};

export default function RegisterPage() {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);

  // Voltar pelo histórico pode restaurar a página do cache do navegador (bfcache) com os
  // campos antigos. O cadastro de uma clínica nova tem de abrir zerado de novo.
  useEffect(() => {
    function resetOnRestore(event: PageTransitionEvent) {
      if (event.persisted) {
        setForm({ ...EMPTY_FORM });
        setErrors({});
      }
    }
    window.addEventListener("pageshow", resetOnRestore);
    return () => window.removeEventListener("pageshow", resetOnRestore);
  }, []);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
    };
  }

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (form.clinicName.trim().length < 2) next.clinicName = "Informe o nome da clínica.";
    if (form.name.trim().length < 2) next.name = "Informe seu nome.";
    if (!EMAIL_RE.test(form.email.trim())) next.email = "Informe um e-mail válido.";
    if (form.password.length < 8) next.password = "A senha precisa ter ao menos 8 caracteres.";
    if (!form.adminToken) next.adminToken = "Informe o token de administrador.";
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
          mode: "new",
          // Clínica e pessoa são dados diferentes: o nome digitado aqui vira a clínica;
          // `name` é quem está criando. A clínica nasce vazia, com essa pessoa como ADMIN.
          barbearia: form.clinicName.trim(),
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          phone: form.phone.trim() || undefined,
          adminToken: form.adminToken.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message =
          typeof data?.error === "string"
            ? data.error
            : "Não foi possível criar o cadastro. Tente novamente.";
        if (res.status === 403) setErrors({ adminToken: message });
        else if (res.status === 409 && data?.field === "phone") setErrors({ phone: message });
        else if (res.status === 409) setErrors({ email: message });
        else setErrors({ form: message });
        return;
      }

      // Troca completa de identidade e de clínica: uma navegação nova evita que o cache do
      // App Router reaproveite a tela/dados da clínica que estava aberta antes do cadastro.
      window.location.replace("/app");
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

        <form onSubmit={onSubmit} className="space-y-4" autoComplete="off">
          <Field
            label="Nome da clínica"
            hint="A clínica começa vazia — você entra como administrador."
            error={errors.clinicName}
          >
            <Input
              value={form.clinicName}
              onChange={set("clinicName")}
              placeholder="Ex.: Bela Face"
              autoComplete="off"
            />
          </Field>
          <Field label="Seu nome" error={errors.name}>
            <Input
              value={form.name}
              onChange={set("name")}
              placeholder="Seu nome"
              autoComplete="off"
            />
          </Field>
          <Field label="E-mail" error={errors.email}>
            <Input
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="voce@email.com"
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

          <Field
            label="WhatsApp da clínica"
            hint="Opcional — pode configurar depois. Um número por clínica."
            error={errors.phone}
          >
            <Input
              value={form.phone}
              onChange={set("phone")}
              placeholder="(11) 99999-9999"
              type="tel"
              autoComplete="off"
            />
          </Field>

          <Field
            label="Token de administrador"
            hint="Gerado na Administração da plataforma — vale 7 dias"
            error={errors.adminToken}
          >
            <Input
              type="text"
              value={form.adminToken}
              onChange={set("adminToken")}
              placeholder="sbx_..."
              autoComplete="off"
              spellCheck={false}
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
