import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { normalizePhone, phoneKey } from "@/lib/phone";
import { findCustomerByPhone, phoneConflictMessage } from "@/modules/crm/customers";
import { linkWhatsAppToCustomer } from "@/modules/whatsapp/inbox";

const updateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  phone: z.string().min(10).max(20).optional(),
  birthday: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  whatsappOptIn: z.boolean().optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await requirePermission("customers:read");
    const { id } = await params;

    const customer = await db.customer.findFirst({
      where: { id, orgId },
      include: {
        metrics: true,
        crmNotes: { orderBy: { createdAt: "desc" } },
        appointments: {
          orderBy: { startAt: "desc" },
          take: 30,
          include: { service: { select: { name: true } }, barber: { select: { name: true } } },
        },
      },
    });
    if (!customer) return jsonOk({ error: "Cliente não encontrado." }, 404);

    return jsonOk({ customer });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("customers:write");
    const { id } = await params;
    const body = updateSchema.parse(await req.json());

    const existing = await db.customer.findFirst({ where: { id, orgId } });
    if (!existing) return jsonOk({ error: "Cliente não encontrado." }, 404);

    if (body.phone) {
      const phone = normalizePhone(body.phone);
      if (phoneKey(phone).length < 10) {
        return jsonOk({ error: "Telefone incompleto: informe o DDD e o número (mínimo 10 dígitos)." }, 400);
      }
      // `exceptId`: o cliente pode continuar com o número que já é dele.
      const dup = await findCustomerByPhone(orgId, phone, { exceptId: id });
      if (dup) return jsonOk({ error: phoneConflictMessage(dup), conflict: { id: dup.id, name: dup.name } }, 409);
    }

    const customer = await db.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.phone !== undefined ? { phone: normalizePhone(body.phone) } : {}),
          ...(body.birthday !== undefined ? { birthday: body.birthday ? new Date(body.birthday) : null } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.whatsappOptIn !== undefined ? { whatsappOptIn: body.whatsappOptIn } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          orgId,
          userId: session.userId,
          action: "customer.update",
          entity: "customer",
          entityId: id,
          before: JSON.stringify({ name: existing.name, phone: existing.phone }),
          after: JSON.stringify({ name: updated.name, phone: updated.phone }),
        },
      });
      return updated;
    });

    // Telefone corrigido/trocado: o histórico de WhatsApp que estava órfão naquele número
    // passa a pertencer a esta ficha (e a conversa volta a aparecer no painel).
    if (body.phone) {
      await linkWhatsAppToCustomer(orgId, customer).catch((err) => {
        console.error("[WhatsApp] Falha ao ligar histórico ao cliente editado:", err);
      });
    }

    return jsonOk({ customer });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("customers:delete");
    const { id } = await params;

    const existing = await db.customer.findFirst({ where: { id, orgId } });
    if (!existing) return jsonOk({ error: "Cliente não encontrado." }, 404);

    const apptCount = await db.appointment.count({ where: { customerId: id } });
    if (apptCount > 0) {
      // LGPD/histórico: mantém registros, anonimiza dados pessoais
      await db.$transaction(async (tx) => {
        const anonymized = await tx.customer.update({
          where: { id },
          data: {
            name: "Cliente removido",
            phone: `anon-${id.slice(0, 8)}`,
            birthday: null,
            notes: null,
            whatsappOptIn: false,
          },
        });
        await tx.auditLog.create({
          data: {
            orgId,
            userId: session.userId,
            action: "customer.anonymize",
            entity: "customer",
            entityId: id,
            before: JSON.stringify({ name: existing.name, phone: existing.phone }),
          },
        });
        return anonymized;
      });
      return jsonOk({ ok: true, anonymized: true });
    }

    await db.$transaction(async (tx) => {
      await tx.customer.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          orgId,
          userId: session.userId,
          action: "customer.delete",
          entity: "customer",
          entityId: id,
          before: JSON.stringify({ name: existing.name, phone: existing.phone }),
        },
      });
    });
    return jsonOk({ ok: true, deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
