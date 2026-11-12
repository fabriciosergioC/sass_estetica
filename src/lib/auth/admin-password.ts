import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Senha de administrador que libera a criação de novas empresas.
 *
 * É uma trava para a tela /register, não um usuário: a senha fica em ADMIN_SIGNUP_PASSWORD
 * (variável de ambiente) e é comparada em tempo constante. Sem a variável configurada o
 * cadastro de clínicas fica desativado em vez de aberto.
 */
const MIN_LENGTH = 8;

export function adminSignupPassword(): string | null {
  const value = process.env.ADMIN_SIGNUP_PASSWORD?.trim();
  if (!value || value.length < MIN_LENGTH) return null;
  return value;
}

export function isAdminSignupPassword(candidate: string): boolean {
  const expected = adminSignupPassword();
  if (!expected) return false;
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
