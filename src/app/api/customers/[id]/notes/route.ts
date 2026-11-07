import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";

const createSchema = z.object({
  content: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { orgId, session } = await requirePermission("customers:write");
    const { id } = await params;
    const body = createSchema.parse(await req.json());

    const customer = await db.customer.findFirst({ where: { id, orgId } });
    if (!customer) return jsonOk({ error: "Cliente não encontrado." }, 404);

    const note = await db.customerNote.create({
      data: { orgId, customerId: id, authorId: session.userId, content: body.content },
    });

    return jsonOk({ note }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}
