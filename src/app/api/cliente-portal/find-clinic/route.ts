import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { phoneKey } from "@/lib/phone";
import { rateLimit } from "@/lib/rate-limit";

/**
 * GET /api/cliente-portal/find-clinic?phone=...
 *
 * Localiza a(s) clínica(s) cujo telefone é o número informado. É o primeiro passo
 * do login do site de agendamento: o cliente digita o WhatsApp da clínica e é
 * encaminhado para o portal dela. Não cria nem exige cadastro de cliente.
 *
 * Compara por dígitos (phoneKey) porque o telefone da clínica é gravado sem "+"
 * no CRM, enquanto o do cliente é gravado como "+DDD...".
 */
export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("phone") ?? "";
    const key = phoneKey(raw);
    if (key.length < 10 || key.length > 11) {
      return NextResponse.json({ error: "Telefone inválido. Inclua DDD." }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = rateLimit(`find-clinic:${ip}`, 20, 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: "Muitas tentativas. Aguarde um momento." }, { status: 429 });
    }

    const orgs = await db.organization.findMany({
      where: { status: "ACTIVE" },
      select: { slug: true, name: true, phone: true },
    });

    const clinicas = orgs
      .filter((org) => phoneKey(org.phone) === key)
      .map((org) => ({ slug: org.slug, name: org.name }));

    return NextResponse.json({ clinicas });
  } catch (err) {
    return handleApiError(err);
  }
}
