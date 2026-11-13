import type { MetadataRoute } from "next";

/**
 * Manifesto do PWA: é o que permite "instalar" o painel no Android (Chrome) e no PC
 * (Chrome/Edge). O `start_url` aponta direto para o painel; sem sessão, o middleware
 * manda para /login e depois devolve para /app.
 *
 * Quem valida a instalação no Chrome exige, além deste arquivo: ícone de 192 e de 512,
 * `display` standalone e um service worker com handler de fetch — os três existem.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Gestão Estética",
    short_name: "Gestão",
    description:
      "Agenda, clientes, WhatsApp automático e faturamento da clínica direto no seu dispositivo.",
    lang: "pt-BR",
    dir: "ltr",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Atalhos ao segurar o ícone do app no Android.
    shortcuts: [
      { name: "Agenda", short_name: "Agenda", url: "/app/agenda" },
      { name: "Clientes", short_name: "Clientes", url: "/app/clientes" },
      { name: "WhatsApp", short_name: "WhatsApp", url: "/app/whatsapp" },
    ],
  };
}
