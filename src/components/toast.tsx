"use client";

import { useEffect, useState } from "react";

export type ToastTone = "success" | "error" | "info";

type ToastItem = { id: number; message: string; tone: ToastTone };

export function toast(message: string, tone: ToastTone = "success") {
  window.dispatchEvent(new CustomEvent("sb:toast", { detail: { message, tone } }));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let counter = 0;
    function onToast(e: Event) {
      const detail = (e as CustomEvent).detail as { message: string; tone: ToastTone };
      const id = ++counter;
      setItems((prev) => [...prev, { id, ...detail }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200);
    }
    window.addEventListener("sb:toast", onToast);
    return () => window.removeEventListener("sb:toast", onToast);
  }, []);

  const tones: Record<ToastTone, string> = {
    success: "border-emerald-500/40 bg-emerald-950/90 text-emerald-200",
    error: "border-red-500/40 bg-red-950/90 text-red-200",
    info: "border-sky-500/40 bg-sky-950/90 text-sky-200",
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`animate-fade-up pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-xl shadow-black/40 backdrop-blur ${tones[t.tone]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
