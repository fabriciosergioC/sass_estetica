"use client";

import { useState } from "react";
import Link from "next/link";

type OrgInfo = {
  name: string;
  slug: string;
  primaryColor: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  instagram: string | null;
  phone: string | null;
};

const fieldBase =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-[color:var(--accent-c)] focus:outline-none transition-colors";

/** Tela de entrada do portal: login OU cadastro por telefone + senha. */
export function ClientShell({ slug, org }: { slug: string; org: OrgInfo }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const accent = org.primaryColor;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/cliente-portal/${slug}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: mode,
          name: mode === "register" ? name.trim() : undefined,
          phone: phone.trim(),
          password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Não foi possível entrar. Tente novamente.");
        return;
      }
      window.location.href = `/c/${slug}/painel`;
    } catch {
      setError("Falha de conexão. Verifique sua internet.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl text-2xl"
            style={{ backgroundColor: `${accent}1a` }}
          >
            ✨
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">{org.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {mode === "login" ? "Acesse sua área do cliente" : "Crie sua conta de cliente"}
          </p>
          {org.description && <p className="mt-0.5 text-xs text-zinc-600">{org.description}</p>}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl shadow-black/40">
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-zinc-950 p-1">
            <button
              onClick={() => { setMode("login"); setError(""); }}
              className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                mode === "login" ? "bg-[color:var(--accent-c)] text-zinc-950" : "text-zinc-400"
              }`}
            >
              Entrar
            </button>
            <button
              onClick={() => { setMode("register"); setError(""); }}
              className={`rounded-md py-1.5 text-sm font-medium transition-colors ${
                mode === "register" ? "bg-[color:var(--accent-c)] text-zinc-950" : "text-zinc-400"
              }`}
            >
              Criar conta
            </button>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "register" && (
              <div className="space-y-1">
                <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400">Seu nome</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Como podemos te chamar?"
                  className={fieldBase}
                  required
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400">WhatsApp (com DDD)</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                placeholder="(11) 99999-9999"
                className={fieldBase}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400">Senha</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className={fieldBase}
                required
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-zinc-950 disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {loading ? "Aguarde..." : mode === "login" ? "Entrar" : "Criar conta"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-zinc-600">
          Já atendeu nesta clínica? Use o mesmo WhatsApp do cadastro.{" "}
          <Link href={`/b/${slug}`} className="underline decoration-zinc-700 hover:text-zinc-400">
            Agendar sem conta
          </Link>
        </p>
      </div>
    </main>
  );
}
