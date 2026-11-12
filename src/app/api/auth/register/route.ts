import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { adminSignupPassword, isAdminSignupPassword } from "@/lib/auth/admin-password";
import { handleApiError } from "@/lib/api";
import { provisionOrganization, uniqueSlug } from "@/modules/organizations/service";

const schema = z.object({
  barbearia: z.string().min(2, "Informe o nome da clínica").max(80),
  name: z.string().min(2, "Informe seu nome").max(80),
  email: z.string().email("E-mail inválido").toLowerCase(),
  password: z.string().min(8, "A senha precisa ter ao menos 8 caracteres").max(72),
  phone: z.string().max(20).optional(),
  adminPassword: z.string().min(1, "Informe a senha de administrador"),
});

export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());

    // Só quem tem a senha de administrador cria novas empresas. Ela é conferida antes de
    // qualquer escrita para não deixar rastro de cadastro recusado.
    if (!adminSignupPassword()) {
      console.error("[register] ADMIN_SIGNUP_PASSWORD não configurada: cadastro de empresas desativado.");
      return NextResponse.json(
        { error: "O cadastro de novas empresas está desativado no servidor." },
        { status: 503 }
      );
    }
    if (!isAdminSignupPassword(body.adminPassword)) {
      return NextResponse.json({ error: "Senha de administrador incorreta." }, { status: 403 });
    }

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

    await setSessionCookie({
      userId: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: false,
      tokenVersion: user.tokenVersion,
      activeOrgId: org.id,
      role: "ADMIN",
    });

    return NextResponse.json({ ok: true, org: { id: org.id, slug: org.slug } }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
