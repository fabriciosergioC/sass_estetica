"use client";

import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "gestao.pwa.instalar.oculto";
/** "Agora não" esconde por 30 dias; depois o convite volta (sem virar incômodo diário). */
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Registro do service worker + convite para instalar o painel como app.
 *
 * - Android/PC (Chrome, Edge, Samsung Internet): usam `beforeinstallprompt` e o botão
 *   abre o diálogo nativo de instalação.
 * - iPhone/iPad: o Safari não dispara esse evento; mostramos o caminho manual
 *   (Compartilhar → Adicionar à Tela de Início).
 * - Já instalado (display-mode standalone) ou dispensado: não aparece.
 * - Páginas públicas de agendamento (/b, /c): não aparece, pois são dos clientes da clínica.
 */
export function PwaInstaller() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("[pwa] não foi possível registrar o service worker", error);
    });
  }, []);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;

    const path = window.location.pathname;
    if (path.startsWith("/b/") || path.startsWith("/c/")) return;

    try {
      const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (dismissedAt && Date.now() - dismissedAt < DISMISS_MS) return;
    } catch {
      /* storage bloqueado: segue sem lembrar a dispensa */
    }

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setPromptEvent(null);
      setVisible(false);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // iOS não tem beforeinstallprompt; detecta Safari no iPhone/iPad para o caminho manual.
    const ua = navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    if (isIos && isSafari) {
      setIosHint(true);
      setVisible(true);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* sem storage, só fecha nesta visita */
    }
  }

  async function install() {
    if (!promptEvent) return;
    setInstalling(true);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === "accepted") setVisible(false);
      else dismiss();
    } finally {
      setInstalling(false);
      setPromptEvent(null);
    }
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Instalar aplicativo de gestão"
      className="fixed inset-x-4 bottom-4 z-[90] sm:inset-x-auto sm:left-6 sm:bottom-6 sm:w-[380px]"
    >
      <div className="flex gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/95 p-4 shadow-2xl shadow-black/50 backdrop-blur">
        <img
          src="/icons/icon-192.png"
          alt=""
          width={44}
          height={44}
          className="h-11 w-11 shrink-0 rounded-xl"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-100">Instale o app de gestão</p>
          {iosHint ? (
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              No Safari, toque em <span className="text-zinc-200">Compartilhar</span> e depois em{" "}
              <span className="text-zinc-200">Adicionar à Tela de Início</span>.
            </p>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              Abra a agenda e o WhatsApp com um toque, direto da tela inicial, sem passar pelo
              navegador.
            </p>
          )}

          <div className="mt-3 flex items-center gap-2">
            {!iosHint && (
              <button
                type="button"
                onClick={install}
                disabled={installing}
                className="rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-gold-400 disabled:opacity-60"
              >
                {installing ? "Abrindo…" : "Instalar"}
              </button>
            )}
            <button
              type="button"
              onClick={dismiss}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
            >
              {iosHint ? "Entendi" : "Agora não"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
