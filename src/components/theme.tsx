"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  ACCENTS,
  DEFAULT_THEME,
  MODES,
  applyTheme,
  chartColors,
  normalizeTheme,
  readTheme,
  writeTheme,
  type AccentId,
  type ThemeMode,
  type ThemePref,
} from "@/lib/theme";

/**
 * Provedor de tema + o controle que fica no rodapé da sidebar.
 *
 * Os DOIS vivem aqui de propósito: é a única porta de entrada para a preferência, então ninguém
 * cria um segundo leitor de `localStorage` nem um segundo botão com outra lista de cores.
 */

type ThemeContextValue = {
  theme: ThemePref;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: AccentId) => void;
  /** Hex para quem não pode usar classe CSS (recharts desenha SVG com valor literal). */
  colors: ReturnType<typeof chartColors>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Começa no padrão e só depois lê o storage: no servidor não existe `window`, e o HTML
  // precisa bater com o primeiro render do cliente. Quem pinta o tema de verdade antes da
  // tela aparecer é o <script> de `src/app/layout.tsx`, não este estado.
  const [theme, setTheme] = useState<ThemePref>(DEFAULT_THEME);

  useEffect(() => {
    const saved = readTheme();
    applyTheme(saved);
    setTheme(saved);
  }, []);

  const update = useCallback(
    (patch: Partial<ThemePref>) => {
      setTheme((prev) => {
        const next = normalizeTheme({ ...prev, ...patch });
        // `applyTheme`/`writeTheme` são idempotentes, então podem rodar dentro do updater sem
        // problema no StrictMode, que chama a função duas vezes.
        applyTheme(next);
        writeTheme(next);
        return next;
      });
    },
    []
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setMode: (mode) => update({ mode }),
      setAccent: (accent) => update({ accent }),
      colors: chartColors(theme),
    }),
    [theme, update]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme() precisa do <ThemeProvider> montado no layout raiz.");
  return ctx;
}

/**
 * Botão de paleta no rodapé da sidebar. Deixa o painel aberto depois de escolher, porque trocar
 * de cor é justamente o momento de olhar o resto da tela.
 */
export function ThemeMenu() {
  const { theme, setMode, setAccent } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
      )}
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          title="Tema do painel"
          aria-label="Tema do painel"
          aria-expanded={open}
          className={`shrink-0 rounded-md p-2 transition-colors ${
            open ? "bg-zinc-800 text-gold-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="13.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="17.5" cy="10.5" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="8.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="6.5" cy="12.5" r="1.5" fill="currentColor" stroke="none" />
            <path
              d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a5 5 0 0 0 5-5c0-4.4-4.5-8-10-8Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {open && (
          // O botão é o último item do cabeçalho da sidebar, então `right-0` põe a borda direita
          // do painel na borda interna do menu (236px numa sidebar de 256) e os 216px abrem para
          // a esquerda, dentro do menu. Antes o painel nascia de um botão no rodapé que tinha o
          // "Sair" depois dele — 44px a menos de espaço — e as cores passavam do lado esquerdo,
          // com o navegador cortando a primeira letra de cada linha.
          // Abre para baixo porque o âncora agora é o topo.
          <div className="animate-fade-up absolute top-full right-0 z-50 mt-2 w-[216px] rounded-xl border border-zinc-800 bg-zinc-900 p-3 shadow-2xl">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Aparência</p>

            <div className="mt-2 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-1">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    theme.mode === m.id ? "bg-gold-500 text-on-accent" : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>

            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Cor de destaque
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5">
              {ACCENTS.map((a) => {
                const active = theme.accent === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => setAccent(a.id)}
                    title={a.label}
                    aria-label={a.label}
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-lg border px-1.5 py-1 text-left transition-colors ${
                      active
                        ? "border-zinc-600 bg-zinc-800/70 text-zinc-100"
                        : "border-transparent text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
                    }`}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: a.hex }}
                    >
                      {active && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0b0b0d" strokeWidth="3">
                          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className="truncate text-xs">{a.label}</span>
                  </button>
                );
              })}
            </div>

            <p className="mt-3 text-[11px] leading-snug text-zinc-500">
              Vale para este navegador e não mexe no que o cliente vê no link de agendamento.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
