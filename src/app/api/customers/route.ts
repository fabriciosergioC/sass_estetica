import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError, parsePagination } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { normalizePhone, phoneKey } from "@/lib/phone";
import { containsCI } from "@/lib/search";
import { findCustomerByPhone, phoneConflictMessage } from "@/modules/crm/customers";

const createSchema = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().min(10, "Telefone inválido").max(20),
  birthday: z.string().optional(), // ISO date
  notes: z.string().max(1000).optional(),
  whatsappOptIn: z.boolean().default(true),
});

export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("customers:read");
    const url = new URL(req.url);
    const { skip, take, page } = parsePagination(url);
    const q = url.searchParams.get("q") ?? "";
    const segment = url.searchParams.get("segment");

    // Busca por número: "98770-7962" precisa achar o cliente gravado como "+55 (31) 98770-7962"
    // e o gravado como "+31987707962". `contains` puro não resolve porque um tem pontuação e o
    // outro não — a comparação é a mesma MESMA chave usada para bloquear duplicidade.
    const digits = q.replace(/\D/g, "");
    const idsByDigits =
      digits.length >= 5
        ? (
            await db.customer.findMany({ where: { orgId }, select: { id: true, phone: true } })
          )
            .filter((c) => phoneKey(c.phone).includes(digits))
            .map((c) => c.id)
        : [];

    const customers = await db.customer.findMany({
      where: {
        orgId,
        ...(q
          ? {
              OR: [
                { name: containsCI(q) },
                { phone: containsCI(q) },
                ...(idsByDigits.length ? [{ id: { in: idsByDigits } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      skip,
      take,
      include: { metrics: true },
    });

    const filtered = segment ? customers.filter((c) => c.metrics?.segment === segment) : customers;

    return jsonOk({
      items: filtered.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        birthday: c.birthday,
        notes: c.notes,
        whatsappOptIn: c.whatsappOptIn,
        createdAt: c.createdAt,
        metrics: c.metrics,
      })),
      total: filtered.length,
      page,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("customers:write");
    const body = createSchema.parse(await req.json());

    const phone = normalizePhone(body.phone);
    if (phoneKey(phone).length < 10) {
      return jsonOk({ error: "Telefone incompleto: informe o DDD e o número (mínimo 10 dígitos)." }, 400);
    }

    // Duplicidade comparada por DÍGITOS. O índice único da tabela é a string, então sozinho ele
    // não barra o mesmo número gravado por outro caminho em outro formato (ver findCustomerByPhone).
    const conflict = await findCustomerByPhone(orgId, phone);
    if (conflict) {
      return jsonOk(
        { error: phoneConflictMessage(conflict), conflict: { id: conflict.id, name: conflict.name } },
        409
      );
    }

    const customer = await db.customer.create({
      data: {
        orgId,
        name: body.name,
        phone,
        birthday: body.birthday ? new Date(body.birthday) : null,
        notes: body.notes,
        whatsappOptIn: body.whatsappOptIn,
      },
    });

    return jsonOk({ customer }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
