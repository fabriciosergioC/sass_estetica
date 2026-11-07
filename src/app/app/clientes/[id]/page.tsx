import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guards";
import { Card, Badge, Button } from "@/components/ui";
import { formatBRL, formatPhone, SEGMENT_META, STATUS_META, formatTimeHHMM } from "@/lib/format";
import { NoteForm } from "./note-form";

export default async function ClienteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { orgId } = await requirePermission("customers:read");
  const { id } = await params;

  const customer = await db.customer.findFirst({
    where: { id, orgId },
    include: {
      metrics: true,
      crmNotes: { orderBy: { createdAt: "desc" }, take: 50 },
      appointments: {
        orderBy: { startAt: "desc" },
        take: 50,
        include: { service: { select: { name: true } }, barber: { select: { name: true } } },
      },
    },
  });
  if (!customer) notFound();

  const authorNames = new Map<string, string>();
  const authorIds = customer.crmNotes.map((n) => n.authorId).filter((v): v is string => Boolean(v));
  if (authorIds.length > 0) {
    const users = await db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } });
    users.forEach((u) => authorNames.set(u.id, u.name));
  }

  const m = customer.metrics;
  const freq = m?.visits && m.avgIntervalDays ? `a cada ~${Math.round(m.avgIntervalDays)} dias` : "—";
  const avgTicket = m && m.visits > 0 ? Math.round(m.totalSpentCents / m.visits) : 0;

  type Entry =
    | { kind: "appointment"; at: Date; appt: (typeof customer.appointments)[number] }
    | { kind: "note"; at: Date; note: (typeof customer.crmNotes)[number] };

  const timeline: Entry[] = [
    ...customer.appointments.map((appt): Entry => ({ kind: "appointment", at: appt.startAt, appt })),
    ...customer.crmNotes.map((note): Entry => ({ kind: "note", at: note.createdAt, note })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const stat = (label: string, value: string) => (
    <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/app/clientes" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Clientes
        </Link>
      </div>

      <Card className="animate-fade-up p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gold-500/15 text-xl font-semibold text-gold-400">
              {customer.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold">{customer.name}</h1>
                {m?.segment && (
                  <Badge tone={SEGMENT_META[m.segment]?.tone ?? "neutral"}>
                    {SEGMENT_META[m.segment]?.label ?? m.segment}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-sm text-zinc-400">{formatPhone(customer.phone)}</p>
              {customer.birthday && (
                <p className="text-xs text-zinc-600">
                  Nascimento: {customer.birthday.toLocaleDateString("pt-BR")}
                </p>
              )}
            </div>
          </div>
          <Link href={`/app/agenda?customerId=${customer.id}`}>
            <Button variant="outline">+ Agendar</Button>
          </Link>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stat("Visitas", String(m?.visits ?? 0))}
          {stat("Total gasto", formatBRL(m?.totalSpentCents ?? 0))}
          {stat("Ticket médio", formatBRL(avgTicket))}
          {stat("Frequência", freq)}
          {stat("Faltas", String(m?.noShows ?? 0))}
          {stat("Cancelamentos", String(m?.cancellations ?? 0))}
          {stat("Última visita", m?.lastVisitAt ? m.lastVisitAt.toLocaleDateString("pt-BR") : "—")}
          {stat(
            "Retorno esperado",
            m?.nextExpectedAt ? m.nextExpectedAt.toLocaleDateString("pt-BR") : "—"
          )}
        </div>

        {customer.notes && (
          <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 text-sm text-zinc-400">
            {customer.notes}
          </p>
        )}
      </Card>

      <Card className="animate-fade-up p-5">
        <h2 className="font-medium">Timeline do cliente</h2>
        <div className="mt-3">
          <NoteForm customerId={customer.id} />
        </div>

        {timeline.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">
            Nenhum atendimento ou anotação ainda. Agende o primeiro atendimento para começar o histórico.
          </p>
        ) : (
          <ol className="mt-6 space-y-0">
            {timeline.map((e, i) => (
              <li key={e.kind === "appointment" ? `a-${e.appt.id}` : `n-${e.note.id}`} className="relative flex gap-4 pb-6">
                {i < timeline.length - 1 && (
                  <span className="absolute left-[13px] top-7 h-[calc(100%-14px)] w-px bg-zinc-800" />
                )}
                <span
                  className={`z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs ${
                    e.kind === "appointment"
                      ? "border-gold-500/40 bg-gold-500/10 text-gold-400"
                      : "border-zinc-700 bg-zinc-900 text-zinc-400"
                  }`}
                >
                  {e.kind === "appointment" ? "📅" : "✎"}
                </span>
                <div className="min-w-0 flex-1">
                  {e.kind === "appointment" ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{e.appt.service.name}</p>
                        <p className="text-xs text-zinc-500">
                          {e.appt.startAt.toLocaleDateString("pt-BR")} às {formatTimeHHMM(e.appt.startAt)} ·{" "}
                          {e.appt.barber.name}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-zinc-400">{formatBRL(e.appt.priceCents)}</span>
                        <Badge tone={STATUS_META[e.appt.status]?.tone ?? "neutral"}>
                          {STATUS_META[e.appt.status]?.label ?? e.appt.status}
                        </Badge>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm text-zinc-300">{e.note.content}</p>
                      <p className="mt-1 text-xs text-zinc-600">
                        {e.note.createdAt.toLocaleString("pt-BR")}
                        {e.note.authorId && authorNames.has(e.note.authorId)
                          ? ` · ${authorNames.get(e.note.authorId)}`
                          : ""}
                      </p>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
