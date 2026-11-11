import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { HttpError, requirePermission } from "@/lib/auth/guards";
import { PAYMENT_METHOD_IDS } from "@/lib/payment-methods";

/**
 * PATCH /api/payments/[id] — corrige valor, forma ou data de um recebimento.
 *
 * Existe porque concluir um atendimento cria o recebimento como Dinheiro (padrão do banco).
 * Quando o cliente paga em PIX ou cartão, o operador ajusta aqui em vez de refazer o caixa.
 */
const patchSchema = z
  .object({
    amountCents: z.number().int().positive("Informe um valor maior que zero.").max(50_000_000).optional(),
    method: z.enum(PAYMENT_METHOD_IDS).optional(),
    paidAt: z.string().optional(),
  })
  .refine((value) => value.amountCents !== undefined || value.method !== undefined || value.paidAt !== undefined, {
    message: "Informe ao menos um campo para atualizar.",
  });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("payments:manage");
    const { id } = await params;
    const body = patchSchema.parse(await req.json());

    const current = await db.payment.findFirst({ where: { id, orgId } });
    if (!current) throw new HttpError(404, "Recebimento não encontrado.");

    let paidAt: Date | undefined;
    if (body.paidAt !== undefined) {
      paidAt = new Date(body.paidAt);
      if (Number.isNaN(paidAt.getTime())) throw new HttpError(400, "Data do recebimento inválida.");
    }

    const payment = await db.payment.update({
      where: { id: current.id },
      data: {
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.method !== undefined ? { method: body.method } : {}),
        ...(paidAt !== undefined ? { paidAt } : {}),
      },
      include: {
        appointment: {
          select: {
            id: true,
            startAt: true,
            customer: { select: { id: true, name: true, phone: true } },
            service: { select: { name: true } },
            barber: { select: { name: true } },
          },
        },
      },
    });

    await db.auditLog
      .create({
        data: {
          orgId,
          userId: session.userId,
          action: "payment.update",
          entity: "payment",
          entityId: payment.id,
          before: JSON.stringify({
            amountCents: current.amountCents,
            method: current.method,
            paidAt: current.paidAt?.toISOString() ?? null,
          }),
          after: JSON.stringify({
            amountCents: payment.amountCents,
            method: payment.method,
            paidAt: payment.paidAt?.toISOString() ?? null,
          }),
        },
      })
      .catch(() => {});

    return jsonOk({ payment });
  } catch (err) {
    return handleApiError(err);
  }
}