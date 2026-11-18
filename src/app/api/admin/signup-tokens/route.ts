import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { createSignupToken } from "@/lib/auth/signup-tokens";
import { handleApiError, jsonOk } from "@/lib/api";

const createSchema = z.object({
  label: z.string().trim().max(60).optional(),
});

/**
 * Tokens de administrador que liberam o cadastro de novas clínicas (tela /register).
 * Só o administrador da plataforma (isSuperAdmin) enxerga e gera.
 */
export async function GET() {
  try {
    await requireSuperAdmin();
    const now = Date.now();
    const items = await db.signupToken.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        label: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        useCount: true,
        lastUsedAt: true,
      },
    });
    return jsonOk({
      items: items.map((t) => ({
        ...t,
        status: t.revokedAt ? "revoked" : t.expiresAt.getTime() <= now ? "expired" : "active",
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/** POST /api/admin/signup-tokens — gera um token novo (válido por 7 dias). */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSuperAdmin();
    const body = createSchema.parse(await req.json().catch(() => ({})));

    const { token, expiresAt, record } = await createSignupToken({
      label: body.label || null,
      createdById: session.userId,
    });

    // O valor em claro sai só nesta resposta; depois disso só o hash fica no banco.
    return jsonOk(
      {
        token,
        item: {
          id: record.id,
          label: record.label,
          createdAt: record.createdAt,
          expiresAt,
          revokedAt: null,
          useCount: 0,
          lastUsedAt: null,
          status: "active",
        },
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE /api/admin/signup-tokens?id=... — revoga um token antes dos 7 dias. */
export async function DELETE(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return jsonOk({ error: "Informe o token a revogar." }, 400);

    const existing = await db.signupToken.findUnique({ where: { id } });
    if (!existing) return jsonOk({ error: "Token não encontrado." }, 404);
    if (existing.revokedAt) return jsonOk({ ok: true });

    await db.signupToken.update({ where: { id }, data: { revokedAt: new Date() } });
    return jsonOk({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
