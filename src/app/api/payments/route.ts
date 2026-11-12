import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { HttpError, requirePermission } from "@/lib/auth/guards";
import { localDateTime } from "@/lib/datetime";
import { DAY_MS, MAX_RANGE_DAYS, parseLocalDate, toKey } from "@/lib/period";
import { PAYMENT_METHOD_IDS } from "@/lib/payment-methods";

/**
 * Recebimentos do caixa, por forma de pagamento.
 *
 * GET lista o que entrou no período (status PAID, por `paidAt`) e devolve os totais de cada
 * forma. O filtro de forma muda só a LISTA: os cartões de resumo continuam somando todas,
 * porque a pergunta do operador é "quanto entrou de PIX comparado ao resto?".
 *
 * Valores sempre em CENTAVOS, como no resto do banco — quem formata R$ é a tela.
 */

const appointmentInclude = {
  appointment: {
    select: {
      id: true,
      startAt: true,
      customer: { select: { id: true, name: true, phone: true } },
      service: { select: { name: true } },
      barber: { select: { name: true } },
    },
  },
} as const;

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("payments:manage");
    const url = new URL(req.url);

    const now = new Date();
    const from = parseLocalDate(url.searchParams.get("from")) ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const to = parseLocalDate(url.searchParams.get("to")) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (from.getTime() > to.getTime()) {
      throw new HttpError(400, "A data inicial não pode vir depois da final.");
    }
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new HttpError(400, `Período muito longo: mostre no máximo ${MAX_RANGE_DAYS} dias por vez.`);
    }

    const rawMethod = url.searchParams.get("method");
    if (rawMethod && !PAYMENT_METHOD_IDS.includes(rawMethod as (typeof PAYMENT_METHOD_IDS)[number])) {
      throw new HttpError(400, "Forma de pagamento inválida.");
    }

    // Limites no fuso da loja: um recebimento às 22h de hoje não pode cair no dia seguinte.
    const start = localDateTime(toKey(from), "00:00");
    const end = new Date(localDateTime(toKey(to), "00:00").getTime() + DAY_MS);
    const whereBase = { orgId, status: "PAID", paidAt: { gte: start, lt: end } };

    const [items, grouped, pendingRows] = await Promise.all([
      db.payment.findMany({
        where: { ...whereBase, ...(rawMethod ? { method: rawMethod } : {}) },
        orderBy: { paidAt: "desc" },
        take: 300,
        include: appointmentInclude,
      }),
      db.payment.groupBy({
        by: ["method"],
        where: whereBase,
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      // Atendimentos concluídos que ainda não têm recebimento. São listados na tela como
      // PENDENTES — não entram no total recebido e não criam linha em Payment: o caixa só
      // ganha o lançamento quando o operador informa valor e forma.
      //
      // A lista ignora o filtro de período de propósito: um atendimento de mês passado sem
      // lançamento continua aparecendo aqui até ser resolvido, em vez de sumir junto com a
      // data. O filtro por forma, sim, esconde os pendentes (eles ainda não têm forma).
      rawMethod
        ? Promise.resolve([])
        : db.appointment.findMany({
            where: {
              orgId,
              status: "COMPLETED",
              payments: { none: { status: "PAID" } },
            },
            orderBy: { startAt: "desc" },
            take: 100,
            select: {
              id: true,
              startAt: true,
              priceCents: true,
              customer: { select: { id: true, name: true, phone: true } },
              service: { select: { name: true } },
              barber: { select: { name: true } },
            },
          }),
    ]);

    const byMethod: Record<string, { cents: number; count: number }> = {};
    for (const id of PAYMENT_METHOD_IDS) byMethod[id] = { cents: 0, count: 0 };
    for (const group of grouped) {
      byMethod[group.method] = {
        cents: group._sum.amountCents ?? 0,
        count: group._count._all,
      };
    }
    const totalCents = Object.values(byMethod).reduce((sum, entry) => sum + entry.cents, 0);

    const pending = pendingRows.map((row) => ({
      appointmentId: row.id,
      amountCents: row.priceCents,
      startAt: row.startAt,
      customer: row.customer,
      service: row.service,
      barber: row.barber,
    }));

    return jsonOk({
      from: toKey(from),
      to: toKey(to),
      items,
      pending,
      totals: {
        totalCents,
        count: Object.values(byMethod).reduce((sum, entry) => sum + entry.count, 0),
        byMethod,
        pendingCents: pending.reduce((sum, entry) => sum + entry.amountCents, 0),
        pendingCount: pending.length,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const createSchema = z.object({
  /** Opcional: sem vínculo, é um recebimento avulso (produto, gorjeta, taxa). */
  appointmentId: z.string().min(1).optional().nullable(),
  amountCents: z.number().int().positive("Informe um valor maior que zero.").max(50_000_000),
  method: z.enum(PAYMENT_METHOD_IDS),
  paidAt: z.string().optional(),
});

/** POST /api/payments — registra um recebimento manual. */
export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("payments:manage");
    const body = createSchema.parse(await req.json());

    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new HttpError(400, "Data do recebimento inválida.");

    let appointmentId: string | null = null;
    if (body.appointmentId) {
      const appointment = await db.appointment.findFirst({
        where: { id: body.appointmentId, orgId },
        select: { id: true },
      });
      if (!appointment) throw new HttpError(404, "Agendamento não encontrado.");

      // Concluir um atendimento já cria o pagamento automaticamente. Registrar outro por cima
      // inflaria o caixa; o caminho certo para trocar a forma é editar o recebimento existente.
      const existing = await db.payment.findFirst({
        where: { orgId, appointmentId: appointment.id, status: "PAID" },
        select: { id: true },
      });
      if (existing) {
        throw new HttpError(409, "Este atendimento já tem recebimento registrado. Edite o recebimento na lista.");
      }
      appointmentId = appointment.id;
    }

    const payment = await db.payment.create({
      data: {
        orgId,
        appointmentId,
        amountCents: body.amountCents,
        method: body.method,
        status: "PAID",
        paidAt,
      },
      include: appointmentInclude,
    });

    await db.auditLog
      .create({
        data: {
          orgId,
          userId: session.userId,
          action: "payment.create",
          entity: "payment",
          entityId: payment.id,
          after: JSON.stringify({
            amountCents: payment.amountCents,
            method: payment.method,
            appointmentId,
          }),
        },
      })
      .catch(() => {});

    return jsonOk({ payment }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}