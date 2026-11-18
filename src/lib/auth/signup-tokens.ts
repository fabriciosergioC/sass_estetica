import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Token de administrador para o cadastro de novas clínicas.
 *
 * Antes era uma senha fixa em ADMIN_SIGNUP_PASSWORD — nunca expirava e não dava para saber
 * quem usou. Agora o administrador da plataforma gera um token na tela /app/admin, ele vale
 * 7 dias (ou até ser revogado) e cada uso fica registrado. O valor em claro só aparece uma
 * vez, na geração; no banco fica apenas o SHA-256.
 */
export const SIGNUP_TOKEN_TTL_DAYS = 7;

const TOKEN_PREFIX = "sbx_";

export function hashSignupToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function generateSignupToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function signupTokenExpiry(from = Date.now()): Date {
  return new Date(from + SIGNUP_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Cria e persiste um token novo. Retorna o valor em claro UMA vez. */
export async function createSignupToken(opts: { label?: string | null; createdById?: string | null }) {
  const token = generateSignupToken();
  const expiresAt = signupTokenExpiry();
  const record = await db.signupToken.create({
    data: {
      tokenHash: hashSignupToken(token),
      label: opts.label ?? null,
      createdById: opts.createdById ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt, record };
}

/**
 * Confere o token e, se válido, registra o uso.
 *
 * A busca é pelo hash único, então não há comparação byte a byte que vaze tempo. Uso repetido
 * dentro dos 7 dias é permitido de propósito: o token libera o cadastro de uma ou mais
 * clínicas novas até expirar — a rotação de 7 dias é a proteção, não o uso único.
 */
export async function useSignupToken(candidate: string): Promise<boolean> {
  const found = await findActiveToken(candidate);
  if (!found) return false;

  await db.signupToken.update({
    where: { id: found.id },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });
  return true;
}

/** Confere o token sem registrar uso — para buscas/consultas, que não criam nada. */
export async function isSignupTokenValid(candidate: string): Promise<boolean> {
  return (await findActiveToken(candidate)) !== null;
}

async function findActiveToken(candidate: string): Promise<{ id: string } | null> {
  const token = candidate.trim();
  if (!token) return null;

  const found = await db.signupToken.findUnique({
    where: { tokenHash: hashSignupToken(token) },
    select: { id: true, expiresAt: true, revokedAt: true },
  });
  if (!found || found.revokedAt || found.expiresAt.getTime() <= Date.now()) return null;
  return { id: found.id };
}
