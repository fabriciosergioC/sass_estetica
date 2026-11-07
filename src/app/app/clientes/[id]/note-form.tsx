"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Textarea } from "@/components/ui";
import { toast } from "@/components/toast";

export function NoteForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!content.trim()) return;
    setSaving(true);
    const res = await fetch(`/api/customers/${customerId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      setContent("");
      toast("Anotação adicionada.");
      router.refresh();
    } else {
      toast("Não foi possível salvar a anotação.", "error");
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Preferências de atendimento, conversas, observações importantes..."
        className="min-h-16"
      />
      <div className="flex justify-end">
        <Button variant="secondary" onClick={save} disabled={saving || !content.trim()}>
          {saving ? "Salvando..." : "Adicionar anotação"}
        </Button>
      </div>
    </div>
  );
}
