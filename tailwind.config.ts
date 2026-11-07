import type { Config } from "tailwindcss";

/**
 * ATENÇÃO: este arquivo NÃO é lido pelo Tailwind neste projeto.
 *
 * Desde a migração para o Tailwind v4 (`@import "tailwindcss"` em `src/app/globals.css` com
 * `@tailwindcss/postcss`), a configuração JS/TS só entra se o CSS chamá-la explicitamente com
 * `@config`. Ninguém chama. Enquanto a paleta `gold` esteve apenas aqui, nenhuma classe
 * `bg-gold-500` foi gerada e o botão primário do CRM saiu invisível.
 *
 * A fonte de verdade passou a ser o bloco `@theme` em `src/app/globals.css`. Mantivemos este
 * arquivo como referência de shape (e para qualquer ferramenta que ainda importe `tailwindcss`
 * no lado JS). Se mudar um tom de dourado, mude nos DOIS ou apague este arquivo.
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Espelha o `@theme` de globals.css — ver o aviso acima.
        gold: {
          300: "#e7c886",
          400: "#dcb367",
          500: "#d4a24e",
          600: "#b0863c",
          700: "#8a672c",
        },
      },
    },
  },
  plugins: [],
};
export default config;
