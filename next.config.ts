import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Otimizações de performance
  experimental: {
    optimizePackageImports: ["date-fns", "zod", "swr"],
  },
  // Baileys é um módulo Node.js nativo (websocket, crypto, fs) — não deve ser bundlado pelo webpack.
  // serverExternalPackages garante que o Next.js faça require() nativo em vez de tentar bundlar.
  // Os extras abaixo existem pelo mesmo motivo: são deps (ou opcionais) que o Baileys importa.
  // sharp/detect-libc usam child_process, e audio-decode/link-preview-js nem estão instalados —
  // bundlar qualquer um deles vira "Module not found" na compilação.
  serverExternalPackages: [
    "@whiskeysockets/baileys",
    "whatsapp-rust-bridge",
    "sharp",
    "detect-libc",
    "audio-decode",
    "link-preview-js",
    "libsignal",
    "qrcode",
  ],
  // Cache mais agressivo
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 10,
  },
  // Otimizações de produção
  poweredByHeader: false,
  reactStrictMode: true,
  // Compressão
  compress: true,
};

export default nextConfig;
