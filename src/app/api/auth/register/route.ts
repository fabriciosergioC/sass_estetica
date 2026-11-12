import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { handleApiError } from "@/lib/api";
import { provisionOrganization, uniqueSlug } from "@/modules/organizations/service";
import { appOrigin, sendConfirmationForUser } from "@/modules/email/verification";

const schema = z.object({
  barbearia: z.string().min(2, "Informe o nome da clínica").max(80),
  name: z.string().min(2, "Informe seu nome").max(80),
  email: z.string().email("E-mail inválido").toLowerCase(),
  password: z.string().min(8, "A senha precisa ter ao menos 8 caracteres").max(72),
  phone: z.string().max(20).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());

    const existing = await db.user.findUnique({ where: { email: body.email } });
    if (existing) {
      return NextResponse.json(
        { error: "Este e-mail já possui cadastro. Faça login." },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(body.password);
    const slug = await uniqueSlug(body.barbearia);

    const { user, org } = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: body.email, passwordHash, name: body.name, phone: body.phone },
      });
      const org = await provisionOrganization({
        name: body.barbearia,
        slug,
        phone: body.phone,
        adminUserId: user.id,
        tx,
      });
      return { user, org };
    });

    // A conta nasce bloqueada para login até o e-mail ser confirmado — por isso não abrimos
    // sessão aqui. O cliente recebe o link e entra pela tela de login depois de confirmar.
    let emailSent = false;
    try {
      const result = await sendConfirmationForUser({
        user: { id: user.id, email: user.email, name: user.name },
        clinicName: org.name,
        origin: appOrigin(req),
      });
      emailSent = result.ok;
    } catch (err) {
      // Conta criada e recuperável: a tela oferece "Reenviar e-mail" e o login tem o mesmo
      // caminho. Falhar aqui não pode desfazer o cadastro da clínica.
      console.error("[register] Falha ao enviar confirmação de e-mail:", err instanceof Error ? err.message : err);
    }

    return NextResponse.json(
      { ok: true, emailSent, email: user.email, org: { id: org.id, slug: org.slug } },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
