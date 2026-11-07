import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

/**
 * Sessão do CLIENTE (portal público), separada da sessão de gestão.
 *
 * Dois cookies de propósito: quem entra no painel de gestão (`sb_session`) nunca
 * herda acesso ao portal do cliente (`sb_client_session`) e vice-versa — mesmo
 * que os payloads tenham formato parecido, os escopos de autêntico são distintos.
 * Assinados com o mesmo SESSION_SECRET (papel de marcação de tab na app).
 */

export const CLIENT_SESSION_COOKIE = "sb_client_session";

const CLIENT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

export type ClientSessionPayload = {
  customerId: string;
  orgId: string;
  name: string;
  phone: string;
};

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error("SESSION_SECRET ausente ou curta demais (mínimo 32 caracteres).");
  }
  return new TextEncoder().encode(raw);
}

export async function createClientSessionToken(payload: ClientSessionPayload): Promise<string> {
  return new SignJWT({ ...payload, scope: "cliente" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${CLIENT_SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifyClientSessionToken(token: string): Promise<ClientSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.customerId || !payload.orgId || payload.scope !== "cliente") return null;
    return payload as unknown as ClientSessionPayload;
  } catch {
    return null;
  }
}

export async function getClientSession(): Promise<ClientSessionPayload | null> {
  const store = await cookies();
  const token = store.get(CLIENT_SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyClientSessionToken(token);
}

export async function setClientSessionCookie(payload: ClientSessionPayload) {
  const token = await createClientSessionToken(payload);
  const store = await cookies();
  store.set(CLIENT_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: CLIENT_SESSION_TTL_SECONDS,
    path: "/",
  });
}

export async function clearClientSessionCookie() {
  const store = await cookies();
  store.delete(CLIENT_SESSION_COOKIE);
}
