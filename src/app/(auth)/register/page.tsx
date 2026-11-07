"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, Field, Input } from "@/components/ui";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    barbearia: "",
    name: "",
    email: "",
    password: "",
    phone: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          phone: form.phone || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Não foi possível criar o cadastro. Tente novamente.");
        return;
      }
      router.push("/app");
      router.refresh();
    } catch {
      setError("Falha de conexão. Verifique sua internet.");
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
          <Field label="Nome da clínica">
            <Input
              value={form.barbearia}
              onChange={set("barbearia")}
              placeholder="Clínica Bela Essência"
              required
            />
          </Field>
          <Field label="Seu nome">
            <Input value={form.name} onChange={set("name")} placeholder="Seu nome" required />
          </Field>
          <Field label="E-mail">
            <Input
              type="email"
              value={form.email}
              onChange={set("email")}
              placeholder="voce@email.com"
              required
              autoComplete="email"
            />
          </Field>
          <Field label="Senha" hint="Mínimo de 8 caracteres">
            <Input
              type="password"
              value={form.password}
              onChange={set("password")}
              placeholder="••••••••"
              required
              minLength={8}
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

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
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
