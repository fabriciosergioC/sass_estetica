"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button, Card, Field, Input } from "@/components/ui";

type State =
  | { kind: "verifying" }
  | { kind: "success"; email: string }
  | { kind: "error"; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ConfirmEmail() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "verifying" });

  // Reenvio (quando o link expirou): mesmo caminho genérico da tela de login.
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  const started = useRef(false);

  useEffect(() => {
    // Strict mode roda o efeito duas vezes em desenvolvimento; o token é de uso único
    // na prática (assim que confirma, a segunda chamada só devolve sucesso de novo).
    if (started.current) return;
    started.current = true;

    if (!token) {
      setState({
        kind: "error",
        message: "Este link está sem o código de confirmação. Peça um novo link abaixo.",
      });
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/auth/confirm-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setState({
            kind: "error",
            message:
              typeof body?.error === "string"
                ? body.error
                : "Não foi possível confirmar o e-mail. Peça um novo link abaixo.",
          });
          return;
        }
        setState({ kind: "success", email: body.email ?? "" });
      } catch {
        setState({
          kind: "error",
          message: "Falha de conexão. Verifique sua internet e abra o link novamente.",
        });
      }
    })();
  }, [token]);

  async function resend() {
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError("Informe o e-mail usado no cadastro.");
      return;
    }
    setEmailError(null);
    setResending(true);
    try {
      const res = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        setEmailError("Não foi possível reenviar agora. Tente novamente em instantes.");
        return;
      }
      setResendNotice("Se este e-mail tiver um cadastro pendente, enviamos um novo link de confirmação.");
    } catch {
      setEmailError("Falha de conexão. Verifique sua internet.");
    } finally {
      setResending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md animate-fade-up p-8">
        {state.kind === "verifying" && (
          <div className="py-6 text-center">
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-gold-500" />
            <h1 className="text-xl font-semibold tracking-tight">Confirmando seu e-mail...</h1>
            <p className="mt-1 text-sm text-zinc-500">Isso leva só um instante.</p>
          </div>
        )}

        {state.kind === "success" && (
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-green-500/10 text-2xl">
                ✅
              </div>
              <h1 className="text-xl font-semibold tracking-tight">E-mail confirmado</h1>
              <p className="mt-1 text-sm text-zinc-500">
                {state.email ? `${state.email} foi confirmado. ` : ""}
                Sua conta está liberada para entrar.
              </p>
            </div>
            <Link
              href={`/login?confirmed=1${state.email ? `&email=${encodeURIComponent(state.email)}` : ""}`}
              className="flex w-full items-center justify-center rounded-lg bg-gold-500 px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-gold-400"
            >
              Entrar na minha clínica
            </Link>
          </>
        )}

        {state.kind === "error" && (
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 text-2xl">
                ⚠️
              </div>
              <h1 className="text-xl font-semibold tracking-tight">Não deu para confirmar</h1>
              <p className="mt-1 text-sm text-zinc-500">{state.message}</p>
            </div>

            <div className="space-y-3">
              <Field label="E-mail do cadastro" error={emailError ?? undefined}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailError(null);
                  }}
                  placeholder="voce@email.com"
                  autoComplete="email"
                />
              </Field>
              <Button onClick={() => void resend()} disabled={resending} className="w-full">
                {resending ? "Enviando..." : "Enviar novo link"}
              </Button>
              {resendNotice && (
                <p className="rounded-lg border border-green-500/30 bg-green-500/[0.08] px-3 py-2 text-sm text-green-300">
                  {resendNotice}
                </p>
              )}
            </div>

            <p className="mt-6 text-center text-sm text-zinc-500">
              <Link href="/login" className="font-medium text-gold-400 hover:text-gold-300">
                Voltar para o login
              </Link>
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
