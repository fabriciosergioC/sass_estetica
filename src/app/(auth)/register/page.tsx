"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Field, Input } from "@/components/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormErrors = {
  barbearia?: string;
  name?: string;
  email?: string;
  password?: string;
  form?: string;
};

export default function RegisterPage() {
  const [form, setForm] = useState({
    barbearia: "",
    name: "",
    email: "",
    password: "",
    phone: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);

  // Cadastro criado: a conta só entra depois do clique no link enviado por e-mail.
  const [sent, setSent] = useState<{ email: string; emailSent: boolean } | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

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
          phone: form.phone.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = typeof data?.error === "string" ? data.error : "Não foi possível criar o cadastro. Tente novamente.";
        // E-mail já cadastrado fica embaixo do campo; o resto vira alerta do formulário.
        if (res.status === 409) setErrors({ email: message });
        else setErrors({ form: message });
        return;
      }

      setSent({
        email: typeof data?.email === "string" ? data.email : form.email.trim(),
        emailSent: Boolean(data?.emailSent),
      });
      // Sem envio, o botão precisa estar liberado para a pessoa tentar de novo na hora.
      setCooldown(data?.emailSent ? 60 : 0);
    } catch {
      setErrors({ form: "Falha de conexão. Verifique sua internet." });
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (!sent || resending || cooldown > 0) return;
    setResending(true);
    setResendNotice(null);
    try {
      const res = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: sent.email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResendNotice("Não foi possível reenviar agora. Tente novamente em instantes.");
        return;
      }
      if (data?.emailSent === false) {
        setResendNotice("O envio de e-mail ainda não está configurado no servidor. Fale com o suporte.");
        return;
      }
      setSent({ ...sent, emailSent: true });
      setResendNotice(`Novo link enviado para ${sent.email}.`);
      setCooldown(60);
    } catch {
      setResendNotice("Falha de conexão. Verifique sua internet.");
    } finally {
      setResending(false);
    }
  }

  if (sent) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md animate-fade-up p-8">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gold-500/10 text-2xl">
              📧
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Confirme seu e-mail</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Enviamos um link de confirmação para <strong className="text-zinc-300">{sent.email}</strong>.
              O acesso à clínica é liberado depois que você clicar nele.
            </p>
          </div>

          {!sent.emailSent && (
            <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-300">
              O e-mail não saiu agora. Use o botão abaixo para tentar novamente.
            </p>
          )}

          <Button onClick={() => void resend()} disabled={resending || cooldown > 0} className="w-full">
            {resending ? "Enviando..." : cooldown > 0 ? `Reenviar em ${cooldown}s` : "Reenviar e-mail"}
          </Button>

          {resendNotice && (
            <p className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300">
              {resendNotice}
            </p>
          )}

          <p className="mt-6 text-center text-sm text-zinc-500">
            Já confirmou?{" "}
            <Link href="/login" className="font-medium text-gold-400 hover:text-gold-300">
              Entrar
            </Link>
          </p>
        </Card>
      </main>
    );
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

          <p className="text-xs text-zinc-500">
            Vamos enviar um link de confirmação para o seu e-mail. A conta só é liberada depois
            que você confirmar.
          </p>

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
