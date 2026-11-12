import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { appOrigin, sendConfirmationForUser } from "@/modules/email/verification";

const schema = z.object({ email: z.string().email("E-mail inválido").toLowerCase() });

/** Intervalo mínimo entre reenvios para o mesmo endereço. */
const COOLDOWN_MS = 60_000;

/**
 * POST /api/auth/resend-confirmation — botão "Reenviar e-mail" do cadastro e do login.
 * A resposta é sempre genérica: não confirma se o e-mail existe, está pendente ou já foi
 * confirmado (isso evitaria enumerar contas).
 */
export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());

    const user = await db.user.findUnique({
      where: { email: body.email },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
        emailVerificationSentAt: true,
      },
    });

    let emailSent: boolean | undefined;

    if (user && !user.emailVerifiedAt) {
      const lastSent = user.emailVerificationSentAt?.getTime() ?? 0;
      if (Date.now() - lastSent < COOLDOWN_MS) {
        // Já saiu um link há menos de um minuto; não dispara outro.
        emailSent = true;
      } else {
        const membership = await db.organizationMember.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
          select: { org: { select: { name: true } } },
        });
        try {
          const result = await sendConfirmationForUser({
            user: { id: user.id, email: user.email, name: user.name },
            clinicName: membership?.org.name ?? "sua clínica",
            origin: appOrigin(req),
          });
          emailSent = result.ok;
        } catch (err) {
          console.error("[resend-confirmation]", err instanceof Error ? err.message : err);
          emailSent = false;
        }
      }
    }

    return NextResponse.json(emailSent === undefined ? { ok: true } : { ok: true, emailSent });
  } catch (err) {
    return handleApiError(err);
  }
}
