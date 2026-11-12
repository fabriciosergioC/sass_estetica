"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, Card, Field, Input } from "@/components/ui";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Conta criada mas ainda não confirmada: o login não abre sessão e oferece o reenvio.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const justConfirmed = params.get("confirmed") === "1";

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nextErrors: typeof fieldErrors = {};
    if (!EMAIL_RE.test(email.trim())) nextErrors.email = "Informe um e-mail válido.";
    if (!password) nextErrors.password = "Informe a senha.";
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    setFieldErrors({});
    setError(null);
    setPendingEmail(null);
    setResendNotice(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Não foi possível entrar. Tente novamente.");
        if (data?.code === "EMAIL_NOT_VERIFIED") {
          setPendingEmail(typeof data.email === "string" ? data.email : email.trim());
        }
        return;
      }
      router.push(params.get("next") ?? "/app");
      router.refresh();
    } catch {
      setError("Falha de conexão. Verifique sua internet.");
    } finally {
      setLoading(false);
    }
  }

  async function resendConfirmation() {
    if (!pendingEmail || resending || cooldown > 0) return;
    setResending(true);
    setResendNotice(null);
    try {
      const res = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.emailSent === false) {
        setResendNotice("Não foi possível reenviar agora. Tente novamente em instantes.");
        return;
      }
      setResendNotice(`Novo link de confirmação enviado para ${pendingEmail}.`);
      setCooldown(60);
    } catch {
      setResendNotice("Falha de conexão. Verifique sua internet.");
    } finally {
      setResending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm animate-fade-up p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gold-500/10 text-2xl">
            ✨
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Bem-vindo de volta</h1>
          <p className="mt-1 text-sm text-zinc-500">Entre para gerenciar sua clínica</p>
        </div>

        {justConfirmed && (
          <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
            E-mail confirmado! Entre com sua senha.
          </p>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="E-mail" error={fieldErrors.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
              }}
              placeholder="voce@email.com"
              autoComplete="email"
              aria-invalid={Boolean(fieldErrors.email)}
            />
          </Field>
          <Field label="Senha" error={fieldErrors.password}>
            <Input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
              }}
              placeholder="••••••••"
              autoComplete="current-password"
              aria-invalid={Boolean(fieldErrors.password)}
            />
          </Field>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <p>{error}</p>
              {pendingEmail && (
                <div className="mt-2 border-t border-red-500/20 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={resendConfirmation}
                    disabled={resending || cooldown > 0}
                  >
                    {resending
                      ? "Enviando..."
                      : cooldown > 0
                        ? `Reenviar em ${cooldown}s`
                        : "Reenviar e-mail de confirmação"}
                  </Button>
                  {resendNotice && (
                    <p className="mt-1 text-xs text-zinc-400">{resendNotice}</p>
                  )}
                </div>
              )}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Entrando..." : "Entrar"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Ainda não tem conta?{" "}
          <Link href="/register" className="font-medium text-gold-400 hover:text-gold-300">
            Criar clínica
          </Link>
        </p>
      </Card>
    </main>
  );
}
