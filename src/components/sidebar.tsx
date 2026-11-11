"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeMenu } from "@/components/theme";
import { Dialog } from "@/components/dialog";
import { isBookingPreview } from "@/lib/nav";
import type { Role } from "@/lib/auth/permissions";

type NavItem = {
  href: string;
  label: string;
  icon: string;
  roles: string[];
};

const NAV: NavItem[] = [
  { href: "/app", label: "Dashboard", icon: "📊", roles: ["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"] },
  { href: "/app/agenda", label: "Agenda", icon: "📅", roles: ["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"] },
  { href: "/app/clientes", label: "Clientes", icon: "👥", roles: ["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"] },
  { href: "/app/estetica", label: "Atendentes", icon: "✨", roles: ["ADMIN", "MANAGER"] },
  { href: "/app/servicos", label: "Serviços", icon: "✨", roles: ["ADMIN", "MANAGER"] },
  // Oculto por pedido do operador em 01/11/2026. A rota /app/oportunidades continua viva
  // (o detector de oportunidades e as automações seguem gravando em Opportunity),
  // basta desarquivar esta linha para o item voltar ao menu.
  // { href: "/app/oportunidades", label: "Oportunidades", icon: "🎯", roles: ["ADMIN", "MANAGER"] },
  { href: "/app/automacoes", label: "Automações", icon: "⚡", roles: ["ADMIN", "MANAGER"] },
  { href: "/app/recebimentos", label: "Recebimentos", icon: "💰", roles: ["ADMIN", "MANAGER", "RECEPTIONIST"] },
  { href: "/app/relatorios", label: "Relatórios", icon: "📈", roles: ["ADMIN", "MANAGER"] },
  { href: "/app/whatsapp", label: "WhatsApp", icon: "💬", roles: ["ADMIN"] },
  { href: "/app/configuracoes", label: "Configurações", icon: "⚙️", roles: ["ADMIN"] },
];

export type ShellUser = {
  name: string;
  email: string;
  role: Role;
  orgName: string;
  activeOrgId: string;
  isSuperAdmin: boolean;
  memberships: Array<{ orgId: string; orgName: string; role: string }>;
};

/** Empresa como ela chega do servidor quando o seletor é aberto. */
type OrgOption = { orgId: string; orgName: string; role: string; viaSuperAdmin: boolean };

export function Sidebar({ user }: { user: ShellUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // A lista é buscada ao abrir o menu. `cachedMemberships` da sessão é retrato do login, então
  // empresa criada depois não aparecia ali — enquanto isso ela serve de conteúdo inicial.
  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  // O servidor responde com a flag lida da conta, então a etiqueta aparece sem precisar relogar.
  const [superAdmin, setSuperAdmin] = useState<boolean | null>(null);
  const [orgsError, setOrgsError] = useState(false);
  const [pendingOrg, setPendingOrg] = useState<OrgOption | null>(null);
  const [switchPassword, setSwitchPassword] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [switching, setSwitching] = useState(false);

  const items = NAV.filter((item) => item.roles.includes(user.role));

  const list: OrgOption[] =
    orgs ?? user.memberships.map((m) => ({ ...m, viaSuperAdmin: false }));

  // O nome no topo vem do cookie (`cachedOrgName`), que é retrato do login: se a empresa foi
  // renomeada depois, a sidebar mostra o nome velho. Depois de abrir o seletor, o nome ao vivo
  // da lista corrige o cabeçalho.
  const activeName = orgs?.find((o) => o.orgId === user.activeOrgId)?.orgName ?? user.orgName;

  // Use useEffect to set active link after hydration to avoid hydration mismatch
  const [activeLink, setActiveLink] = useState<string | null>(null);

  useEffect(() => {
    // Determine active link after initial render
    const path = pathname;
    const matchingItem = items.find((item) =>
      item.href === path || (path.startsWith(item.href) && item.href !== "/app")
    );
    setActiveLink(matchingItem?.href ?? null);
  }, [pathname, items]);
  async function toggleSwitcher() {
    const next = !switcherOpen;
    setSwitcherOpen(next);
    if (!next) return;
    setOrgsError(false);
    try {
      const res = await fetch("/api/auth/orgs", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOrgsError(true);
        return;
      }
      setOrgs(data.items ?? []);
      setSuperAdmin(Boolean(data.isSuperAdmin));
    } catch {
      setOrgsError(true);
    }
  }

  function requestOrgSwitch(option: OrgOption) {
    setSwitcherOpen(false);
    if (option.orgId === user.activeOrgId) return;
    setSwitchPassword("");
    setSwitchError("");
    setPendingOrg(option);
  }

  async function confirmOrgSwitch() {
    if (!pendingOrg || switching) return;
    setSwitching(true);
    setSwitchError("");
    try {
      const res = await fetch("/api/auth/switch-org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: pendingOrg.orgId, password: switchPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSwitchError(data.error || "Não foi possível trocar de empresa.");
        return;
      }
      setPendingOrg(null);
      router.refresh();
    } catch {
      setSwitchError("Não foi possível trocar de empresa.");
    } finally {
      setSwitching(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const comMenu = !isBookingPreview(pathname);

  return (
    <>
      {/*
        Topbar mobile — só onde existe o menu para abrir. Na tela do link de agendamento o
        `<aside>` abaixo não é renderizado, então o hambúrguer aqui era um botão que não abria
        nada (e ainda empurrava o conteúdo da página para baixo).
      */}
      {comMenu && (
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
          <span className="font-semibold tracking-tight">{activeName}</span>
          <div className="h-8 w-8 rounded-full bg-gold-500/15 text-center text-xs leading-8 text-gold-400">
            {initials}
          </div>
        </div>
      )}

      {comMenu && open && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />
      )}

      {comMenu && (
        <aside
          className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform lg:translate-x-0 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {/*
            Cabeçalho = marca + empresa + tema. O seletor de tema mora aqui, e não no rodapé:
            no rodapé ele divide a linha com avatar, nome, e-mail e sair, então a direita do
            botão ficava a 44px da borda interna da sidebar — nenhum painel de cores largo o
            bastante para as seis opções cabia sem passar do lado esquerdo e ser cortado.
            Ancorado aqui, com `right-0` e 216px, ele abre exatamente dentro da sidebar.
          */}
          <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-4">
            <span className="text-xl">✨</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{activeName}</p>
              <button
                onClick={toggleSwitcher}
                className="text-xs text-zinc-500 hover:text-gold-400"
              >
                trocar de empresa ▾
              </button>
            </div>
            <ThemeMenu />
          </div>

          {switcherOpen && (
            <div className="max-h-72 overflow-y-auto border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
              {(superAdmin ?? user.isSuperAdmin) && (
                <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                  administrador da plataforma
                </p>
              )}
              {orgsError && (
                <p className="px-2 pb-1 text-xs text-zinc-500">
                  Não foi possível atualizar a lista; mostrando as empresas do seu login.
                </p>
              )}
              {list.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-zinc-500">Nenhuma empresa encontrada.</p>
              )}
              {list.map((m) => (
                <button
                  key={m.orgId}
                  onClick={() => requestOrgSwitch(m)}
                  className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-800 ${
                    m.orgId === user.activeOrgId
                      ? "text-gold-400"
                      : "text-zinc-300 hover:text-zinc-100"
                  }`}
                >
                  {m.orgName}
                  {m.orgId === user.activeOrgId && <span className="ml-1 text-gold-500">•</span>}
                  {/* Deixa visível que aquela empresa não é dele — é acesso de administração. */}
                  {m.viaSuperAdmin && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-zinc-600">
                      acesso administrativo
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
            {items.map((item) => {
              const isActive = activeLink === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-gold-500/10 font-medium text-gold-400"
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
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold-500/15 text-xs font-semibold text-gold-400">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{user.name}</p>
                <p className="truncate text-xs text-zinc-500">{user.email}</p>
              </div>
              <button
                onClick={logout}
                title="Sair"
                className="shrink-0 rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </aside>
      )}

      <Dialog
        open={Boolean(pendingOrg)}
        onClose={() => {
          if (!switching) setPendingOrg(null);
        }}
        title="Confirmar troca de empresa"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirmOrgSwitch();
          }}
          className="space-y-4"
        >
          <p className="text-sm text-zinc-400">
            Para acessar <strong className="text-zinc-100">{pendingOrg?.orgName}</strong>, informe sua senha.
          </p>
          <input
            type="password"
            value={switchPassword}
            onChange={(event) => setSwitchPassword(event.target.value)}
            placeholder="Senha do usuário"
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-gold-500"
          />
          {switchError && <p className="text-sm text-red-400">{switchError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingOrg(null)}
              disabled={switching}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={switching || !switchPassword}
              className="rounded-lg bg-gold-500 px-3 py-2 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {switching ? "Verificando..." : "Acessar empresa"}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
