/**
 * Preferência de tema do painel: modo (claro/escuro) + cor de destaque.
 *
 * Fica em `src/lib` porque é puro e lido de três lugares diferentes:
 *  1. `src/app/layout.tsx` — gera o <script> que aplica o tema no <html> ANTES da primeira
 *     pintura (sem isso a tela piscaria dourada-escura antes de virar o que o usuário escolheu);
 *  2. `src/components/theme.tsx` — o botão da sidebar;
 *  3. os gráficos de Relatórios, que recebem hex direto do recharts (SVG não resolve `var()`).
 *
 * A escolha é do navegador (`localStorage`), não da conta: nada aqui toca o banco.
 *
 * Como a cor chega na tela: o Tailwind v4 compila `bg-gold-500` para `var(--color-gold-500)`,
 * então quem define o visual é o bloco de `:root` de `src/app/globals.css`, que deriva tudo do
 * `data-theme` e do `data-accent` gravados no <html>. Os IDs abaixo têm que bater com os
 * seletores daquele arquivo — é a única costura entre os dois.
 */

export type ThemeMode = "dark" | "light";

export const MODES: Array<{ id: ThemeMode; label: string; icon: string }> = [
  { id: "dark", label: "Escuro", icon: "🌙" },
  { id: "light", label: "Claro", icon: "☀️" },
];

/**
 * Uma cor por opção — só o tom base; os degraus 300/400/600/700 são derivados dele no CSS.
 * Todas são tons médios, então funcionam tanto como fundo de botão (com texto escuro por cima)
 * quanto como texto/link sobre o fundo.
 */
export const ACCENTS = [
  { id: "gold", label: "Dourado", hex: "#d4a24e" },
  { id: "azul", label: "Azul", hex: "#4f8fd6" },
  { id: "verde", label: "Verde", hex: "#3aa876" },
  { id: "roxo", label: "Roxo", hex: "#8b6fd6" },
  { id: "rosa", label: "Rosa", hex: "#d9629b" },
  { id: "vermelho", label: "Vermelho", hex: "#d9534f" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];

export type ThemePref = { mode: ThemeMode; accent: AccentId };

export const THEME_KEY = "crm.tema.v1";

/** O padrão é exatamente o que o CRM sempre foi: dourado sobre fundo escuro. */
export const DEFAULT_THEME: ThemePref = { mode: "dark", accent: "gold" };

/** Link público de agendamento e portal do cliente: sempre a identidade da barbearia, sem tema. */
export const PUBLIC_PREFIXES = ["/b/", "/c/"];

export function isPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export function accentHex(accent: AccentId): string {
  return ACCENTS.find((a) => a.id === accent)?.hex ?? ACCENTS[0].hex;
}

/** Aceita qualquer coisa vinda do storage e devolve um tema válido — dado velho não quebra a tela. */
export function normalizeTheme(raw: unknown): ThemePref {
  const value = (raw ?? {}) as Partial<Record<keyof ThemePref, unknown>>;
  const mode: ThemeMode = value.mode === "light" || value.mode === "dark" ? value.mode : DEFAULT_THEME.mode;
  const accent = ACCENTS.find((a) => a.id === value.accent)?.id ?? DEFAULT_THEME.accent;
  return { mode, accent };
}

export function readTheme(): ThemePref {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    return normalizeTheme(JSON.parse(window.localStorage.getItem(THEME_KEY) ?? "null"));
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeTheme(pref: ThemePref): void {
  try {
    window.localStorage.setItem(THEME_KEY, JSON.stringify(pref));
  } catch {
    /* Modo privado / storage cheio: o tema vale para a sessão, só não sobrevive ao F5. */
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", pref.mode);
  root.setAttribute("data-accent", pref.accent);
}

/**
 * Versão autônoma do `applyTheme` para rodar inline no <head>: não existe módulo no navegador
 * nesse ponto, então o corpo é escrito à mão e só recebe os dados deste arquivo por interpolação.
 * Isso mantém `ACCENTS`/`THEME_KEY` como fonte única sem duplicar lista.
 */
export function bootstrapScript(): string {
  const accents = JSON.stringify(ACCENTS.map((a) => a.id));
  const publics = JSON.stringify(PUBLIC_PREFIXES);
  return [
    "(function(){try{",
    `var p=location.pathname;if(${publics}.some(function(x){return p.indexOf(x)===0}))return;`,
    `var s=JSON.parse(localStorage.getItem(${JSON.stringify(THEME_KEY)})||"null")||{};`,
    `var m=(s.mode==="light"||s.mode==="dark")?s.mode:${JSON.stringify(DEFAULT_THEME.mode)};`,
    `var a=${accents}.indexOf(s.accent)>=0?s.accent:${JSON.stringify(DEFAULT_THEME.accent)};`,
    "var r=document.documentElement;",
    'r.setAttribute("data-theme",m);r.setAttribute("data-accent",a);',
    "}catch(e){}})();",
  ].join("");
}

/**
 * Paleta para o recharts. Ele pinta SVG com valores literais (`stroke="#27272a"`), e atributo de
 * apresentação não resolve `var()` de CSS — por isso o hex vem daqui, espelhando o que o
 * `globals.css` usa em cada modo.
 */
export function chartColors(pref: ThemePref) {
  const light = pref.mode === "light";
  return {
    accent: accentHex(pref.accent),
    grid: light ? "#e4e4e7" : "#27272a",
    axis: light ? "#a1a1aa" : "#52525b",
    tick: light ? "#5a5a62" : "#71717a",
    bar: light ? "#d4d4d8" : "#3f3f46",
    tooltipBg: light ? "#ffffff" : "#18181b",
    tooltipBorder: light ? "#e4e4e7" : "#27272a",
    tooltipText: light ? "#101012" : "#fafafa",
  };
}
