"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input } from "@/components/ui";
import { toast } from "@/components/toast";

type TokenItem = {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
  status: "active" | "expired" | "revoked";
};

const STATUS_LABEL: Record<TokenItem["status"], string> = {
  active: "Ativo",
  expired: "Expirado",
  revoked: "Revogado",
};

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function SignupTokensPanel() {
  const [items, setItems] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  // O valor em claro só existe nesta resposta: depois só o hash fica no banco.
  const [fresh, setFresh] = useState<{ token: string; expiresAt: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/signup-tokens", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível carregar os tokens.", "error");
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

  async function generate() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/signup-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível gerar o token.", "error");
        return;
      }
      setFresh({ token: data.token, expiresAt: data.item.expiresAt });
      setLabel("");
      setItems((prev) => [data.item, ...prev]);
    } catch {
      toast("Falha de conexão. Tente novamente.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (revoking) return;
    setRevoking(id);
    try {
      const res = await fetch(`/api/admin/signup-tokens?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Não foi possível revogar.", "error");
        return;
      }
      setItems((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "revoked", revokedAt: new Date().toISOString() } : t))
      );
      toast("Token revogado.");
    } catch {
      toast("Falha de conexão. Tente novamente.", "error");
    } finally {
      setRevoking(null);
    }
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      toast("Token copiado.");
    } catch {
      toast("Não foi possível copiar; selecione o texto manualmente.", "error");
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="font-medium">Gerar token de administrador</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Vale por 7 dias. Depois disso expira sozinho e é preciso gerar outro. Pode ser revogado
          antes a qualquer momento.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Para quem (opcional)" hint="Anotação livre, só para você se lembrar">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex.: Sandra — clínica nova"
                maxLength={60}
              />
            </Field>
          </div>
          <Button onClick={generate} disabled={creating}>
            {creating ? "Gerando..." : "Gerar token"}
          </Button>
        </div>

        {fresh && (
          <div className="mt-4 rounded-lg border border-gold-500/40 bg-gold-500/5 p-4">
            <p className="text-xs uppercase tracking-wide text-zinc-400">
              Copie agora — não será mostrado de novo
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="flex-1 select-all break-all rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-gold-300">
                {fresh.token}
              </code>
              <Button variant="secondary" onClick={copy} className="shrink-0">
                Copiar
              </Button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">Expira em {when(fresh.expiresAt)}.</p>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Tokens gerados</h2>
          <Button variant="ghost" onClick={load} disabled={loading}>
            {loading ? "Atualizando..." : "Atualizar"}
          </Button>
        </div>

        {!loading && items.length === 0 && (
          <p className="mt-4 text-sm text-zinc-500">
            Nenhum token ainda. Gere o primeiro para liberar o cadastro de clínicas.
          </p>
        )}

        {items.length > 0 && (
          <div className="mt-4 divide-y divide-zinc-800">
            {items.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-200">
                    {t.label || "Sem anotação"}
                    <span className="ml-2">
                      <Badge
                        tone={t.status === "active" ? "green" : t.status === "expired" ? "neutral" : "red"}
                      >
                        {STATUS_LABEL[t.status]}
                      </Badge>
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Criado {when(t.createdAt)} · expira {when(t.expiresAt)} · usado {t.useCount}{" "}
                    {t.useCount === 1 ? "vez" : "vezes"}
                  </p>
                </div>
                {t.status === "active" && (
                  <Button
                    variant="danger"
                    onClick={() => revoke(t.id)}
                    disabled={revoking === t.id}
                  >
                    {revoking === t.id ? "Revogando..." : "Revogar"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
