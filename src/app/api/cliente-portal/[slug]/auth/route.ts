import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { normalizePhone } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";
import { setClientSessionCookie, clearClientSessionCookie, getClientSession } from "@/lib/auth/client-session";

/**
 * Auth do portal do cliente, por clínica (slug na URL).
 *
 * O acesso é realizado apenas pelo telefone já cadastrado no CRM da clínica.
 */

const schema = z.object({
  phone: z.string().trim().min(10, "Telefone inválido.").max(20),
});

async function orgFromSlug(slug: string) {
  return db.organization.findUnique({ where: { slug } });
}

/** POST /api/cliente-portal/[slug]/auth — { action: "login" | "logout", phone } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const org = await orgFromSlug(slug);
    if (!org || org.status !== "ACTIVE") {
      return NextResponse.json({ error: "Clínica indisponível." }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action;

    if (action === "logout") {
      await clearClientSessionCookie();
      return NextResponse.json({ ok: true });
    }

    if (await getClientSession()) {
      return NextResponse.json({ error: "Você já está logado. Recarregue a página." }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = rateLimit(`cliente-auth:${ip}`, 10, 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: "Muitas tentativas. Aguarde um momento." }, { status: 429 });
    }

    const parsed = schema.parse(body);
    const phone = normalizePhone(parsed.phone);
    if (!phone || phone.length < 11) {
      return NextResponse.json({ error: "Telefone inválido. Inclua DDD." }, { status: 400 });
    }

    const customer = await db.customer.findUnique({
      where: { orgId_phone: { orgId: org.id, phone } },
    });

    if (!customer) {
      return NextResponse.json(
        { error: "Telefone não cadastrado nesta clínica." },
        { status: 401 }
      );
    }

    await setClientSessionCookie({
      customerId: customer.id,
      orgId: org.id,
      name: customer.name,
      phone: customer.phone,
    });

    return NextResponse.json({
      ok: true,
      cliente: { name: customer.name, phone: customer.phone },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
