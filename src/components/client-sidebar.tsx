"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Sidebar do PORTAL DO CLIENTE — espelha o layout da sidebar de gestão
 * (/components/sidebar.tsx) mas mais enxuto: só as seções do cliente.
 */
export function ClientSidebar({
  slug,
  orgName,
  clienteName,
}: {
  slug: string;
  orgName: string;
  clienteName: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const NAV = [
    { href: `/c/${slug}/painel`, label: "Início", icon: "🏠" },
    { href: `/c/${slug}/agendar`, label: "Novo agendamento", icon: "📅" },
    { href: `/c/${slug}/meus-agendamentos`, label: "Meus agendamentos", icon: "🔖" },
    { href: `/c/${slug}/historico`, label: "Histórico", icon: "🕘" },
  ];

  const initials = clienteName
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  async function logout() {
    await fetch(`/api/cliente-portal/${slug}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push(`/c/${slug}`);
    router.refresh();
  }

  return (
    <>
      {/* Topbar mobile — mesmo padrão do painel de gestão */}
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur lg:hidden">
        <button
          onClick={() => setOpen(!open)}
          className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Abrir menu"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
          </svg>
        </button>
        <span className="font-semibold tracking-tight">{orgName}</span>
        <div className="h-8 w-8 rounded-full text-center text-xs leading-8 text-[[color:var(--accent-c)]]" style={{ backgroundColor: "color-mix(in srgb, var(--accent-c) 15%, transparent)" }}>
          {initials}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-4">
          <span className="text-xl">✨</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{orgName}</p>
            <p className="truncate text-xs text-zinc-600">Portal do cliente</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV.map((item) => {
            const active =
              item.href === `/c/${slug}/painel` ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-[color-mix(in_srgb,var(--accent-c)_10%,transparent)] font-medium text-[color:var(--accent-c)]"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-zinc-800 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              style={{ backgroundColor: "color-mix(in srgb, var(--accent-c) 15%, transparent)", color: "var(--accent-c)" }}
            >
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{clienteName}</p>
            </div>
            <button
              onClick={logout}
              title="Sair"
              className="rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
