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

/** Tela de entrada do portal: acesso pelo telefone cadastrado na clínica. */
export function ClientShell({ slug, org }: { slug: string; org: OrgInfo }) {
  const [phone, setPhone] = useState("");
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
        body: JSON.stringify({ action: "login", phone: phone.trim() }),
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
          <p className="mt-1 text-sm text-zinc-500">Acesse pelo seu telefone cadastrado nesta clínica</p>
          {org.description && <p className="mt-0.5 text-xs text-zinc-600">{org.description}</p>}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl shadow-black/40">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <label className="block text-xs font-medium uppercase tracking-wide text-zinc-400">WhatsApp (com DDD)</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
                placeholder="(11) 99999-9999"
                className={fieldBase}
                required
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
              {loading ? "Aguarde..." : "Entrar"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-zinc-600">
          O telefone precisa estar cadastrado nesta clínica.{" "}
          <Link href={`/b/${slug}`} className="underline decoration-zinc-700 hover:text-zinc-400">
            Agendar sem conta
          </Link>
        </p>
      </div>
    </main>
  );
}
