import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { SignupTokensPanel } from "./signup-tokens-panel";

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.isSuperAdmin) redirect("/app");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Administração da plataforma</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Tokens que liberam o cadastro de novas clínicas na tela “Criar clínica”.
        </p>
      </header>

      <SignupTokensPanel />
    </div>
  );
}
