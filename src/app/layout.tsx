import type { Metadata, Viewport } from "next";
import { PwaInstaller } from "@/components/pwa";
import { ThemeProvider } from "@/components/theme";
import { bootstrapScript, DEFAULT_THEME } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SaaS Clínica",
    template: "%s · SaaS Clínica",
  },
  description:
    "Plataforma de gestão inteligente para clínicas: agenda, CRM, WhatsApp automático e oportunidades de faturamento.",
  // PWA: nome usado pelo Android/Windows quando o painel é instalado e pelo iOS na tela inicial.
  applicationName: "Gestão Estética",
  appleWebApp: {
    capable: true,
    title: "Gestão",
    statusBarStyle: "black",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="pt-BR"
      data-theme={DEFAULT_THEME.mode}
      data-accent={DEFAULT_THEME.accent}
      // O script abaixo reescreve estes dois atributos antes da primeira pintura, e o React não
      // pode reclamar da diferença entre o HTML e o que ele renderizou no servidor.
      suppressHydrationWarning
    >
      <head>
        {/*
          Aplica o tema salvo ainda no <head>: se ficasse para o React (efeito no cliente), quem
          escolheu o modo claro veria um flash do fundo escuro em toda navegação.
        */}
        <script dangerouslySetInnerHTML={{ __html: bootstrapScript() }} />
        {/* O Next emite `mobile-web-app-capable`; o iOS mais antigo ainda lê a variante Apple. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        {/* Registra o service worker e oferece a instalação do PWA (Android, PC e iOS). */}
        <PwaInstaller />
      </body>
    </html>
  );
}
