import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { readEmailVerificationToken } from "@/modules/email/verification";

const schema = z.object({ token: z.string().min(10) });

/**
 * POST /api/auth/confirm-email — chamado pela página /confirmar-email.
 *
 * É POST de propósito: scanners de e-mail que só visitam o link (GET) não ativam a conta
 * sozinhos. A página recebe o token na URL e faz esta chamada no navegador do usuário.
 */
export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());
    const verified = await readEmailVerificationToken(body.token);
    if (!verified) {
      return NextResponse.json(
        { error: "Este link de confirmação expirou ou é inválido. Peça um novo na tela de entrada." },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({
      where: { id: verified.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user || user.email !== verified.email) {
      return NextResponse.json(
        { error: "Este link não corresponde mais ao cadastro. Peça um novo na tela de entrada." },
        { status: 400 }
      );
    }

    if (!user.emailVerifiedAt) {
      await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    }

    return NextResponse.json({ ok: true, email: user.email });
  } catch (err) {
    return handleApiError(err);
  }
}
