import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { normalizePhone } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { setClientSessionCookie, clearClientSessionCookie, getClientSession } from "@/lib/auth/client-session";

/**
 * Auth do portal do cliente, por barbearia (slug na URL).
 *
 * Cadastro/login por TELEFONE + SENHA (o telefone é o identificador natural do
 * cliente de barbearia — e-mail caiu em desuso nesse público). Sem e-mail,
 * sem verificação em duas etapas: o dono gerencia o cliente pelo CRM.
 */

const schema = z.object({
  phone: z.string().trim().min(10, "Telefone inválido.").max(20),
  password: z.string().min(6, "A senha precisa ter ao menos 6 caracteres").max(72),
  name: z.string().trim().min(2, "Informe seu nome.").max(80).optional(),
});

async function orgFromSlug(slug: string) {
  return db.organization.findUnique({ where: { slug } });
}

/** POST /api/cliente-portal/[slug]/auth — { action: "register" | "login" | "logout" } */
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

    const parsed = schema.parse(await req.json());
    const phone = normalizePhone(parsed.phone);
    if (!phone || phone.length < 11) {
      return NextResponse.json({ error: "Telefone inválido. Inclua DDD." }, { status: 400 });
    }

    let customer = await db.customer.findUnique({
      where: { orgId_phone: { orgId: org.id, phone } },
    });

    if (action === "register") {
      if (!parsed.name) {
        return NextResponse.json({ error: "Informe seu nome." }, { status: 400 });
      }
      if (customer) {
        // Cliente já existia no CRM (criado pela recepção): também permite criar
        // senha — vínculo com o telefone prova posse do número.
        if (customer.passwordHash) {
          return NextResponse.json(
            { error: "Este telefone já possui cadastro. Faça login." },
            { status: 409 }
          );
        }
        const passwordHash = await hashPassword(parsed.password);
        customer = await db.customer.update({
          where: { id: customer.id },
          data: { passwordHash, name: customer.name || parsed.name },
        });
      } else {
        const passwordHash = await hashPassword(parsed.password);
        customer = await db.customer.create({
          data: { orgId: org.id, name: parsed.name, phone, passwordHash },
        });
      }
    } else {
      // login
      if (!customer?.passwordHash) {
        return NextResponse.json(
          { error: "Telefone não cadastrado. Crie sua conta primeiro." },
          { status: 401 }
        );
      }
      const ok = await verifyPassword(parsed.password, customer.passwordHash);
      if (!ok) {
        return NextResponse.json({ error: "Telefone ou senha incorretos." }, { status: 401 });
      }
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
