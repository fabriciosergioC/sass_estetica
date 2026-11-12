import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";
import nodemailer, { type Transporter } from "nodemailer";
import { db } from "@/lib/db";

/**
 * Confirmação de e-mail do cadastro da clínica.
 *
 * O link carrega um JWT assinado (24h) — não precisa de tabela de tokens e não guarda o
 * segredo em lugar nenhum. Quem confirma é a rota POST /api/auth/confirm-email, chamada pela
 * página /confirmar-email: scanner de e-mail que só abre o link (GET) não confirma a conta
 * sozinho.
 *
 * Envio: Gmail por SMTP quando GMAIL_USER + GMAIL_APP_PASSWORD estão configurados — é o caminho
 * que entrega para qualquer destinatário sem domínio próprio. Sem eles, cai no Resend
 * (RESEND_API_KEY + EMAIL_FROM), que só entrega para o dono da conta enquanto o remetente for
 * onboarding@resend.dev.
 */

const PURPOSE = "email-verification";
const TOKEN_TTL = "24h";

function tokenSecret(): Uint8Array {
  const raw = process.env.EMAIL_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error("EMAIL_TOKEN_SECRET/SESSION_SECRET ausente ou curta demais (mínimo 32 caracteres).");
  }
  return new TextEncoder().encode(raw);
}

export async function createEmailVerificationToken(user: { id: string; email: string }): Promise<string> {
  return new SignJWT({ purpose: PURPOSE, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(tokenSecret());
}

export type VerifiedEmailToken = { userId: string; email: string };

/** `null` para link expirado, adulterado ou de outro tipo. */
export async function readEmailVerificationToken(token: string): Promise<VerifiedEmailToken | null> {
  try {
    const { payload } = await jwtVerify(token, tokenSecret());
    if (payload.purpose !== PURPOSE) return null;
    if (!payload.sub || typeof payload.email !== "string") return null;
    return { userId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export type EmailSendResult = {
  ok: boolean;
  /** `not_configured` = nenhum provedor utilizável; `provider_error` = provedor recusou/indisponível. */
  reason?: "not_configured" | "provider_error";
};

/** URL pública do app: APP_URL quando definido; senão o host da própria requisição. */
export function appOrigin(req: NextRequest): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

/**
 * Gera o link, envia e registra o horário do envio (usado para o intervalo mínimo entre
 * reenvios). Nunca lança: devolve o motivo para a tela dizer "reenvie".
 */
export async function sendConfirmationForUser(opts: {
  user: { id: string; email: string; name: string };
  clinicName: string;
  origin: string;
}): Promise<EmailSendResult> {
  const token = await createEmailVerificationToken(opts.user);
  const url = `${opts.origin.replace(/\/+$/, "")}/confirmar-email?token=${encodeURIComponent(token)}`;

  const result = await sendVerificationEmail({
    to: opts.user.email,
    name: opts.user.name,
    clinicName: opts.clinicName,
    url,
  });

  if (result.ok) {
    await db.user
      .update({ where: { id: opts.user.id }, data: { emailVerificationSentAt: new Date() } })
      .catch((err) => console.error("[email] não foi possível registrar o envio:", err));
  }
  return result;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SENDER_NAME = "Bela Agenda";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type GmailCredentials = { user: string; pass: string };

/**
 * O Gmail é o caminho que entrega para qualquer destinatário sem domínio próprio.
 * A senha de app tem 16 caracteres; valores marcadores (PENDENTE_*) deixados na Railway
 * não contam como configurados.
 */
function gmailCredentials(): GmailCredentials | null {
  const user = (process.env.GMAIL_USER ?? "").trim();
  const pass = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return null;
  if (pass.startsWith("PENDENTE") || pass.length !== 16) return null;
  return { user, pass };
}

function resendApiKey(): string | null {
  const key = (process.env.RESEND_API_KEY ?? "").trim();
  if (!key.startsWith("re_") || key.startsWith("PENDENTE")) return null;
  return key;
}

let gmailTransport: Transporter | null = null;
let gmailTransportUser: string | null = null;

function gmailTransportFor(creds: GmailCredentials): Transporter {
  if (!gmailTransport || gmailTransportUser !== creds.user) {
    gmailTransport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: creds.user, pass: creds.pass },
    });
    gmailTransportUser = creds.user;
  }
  return gmailTransport;
}

async function sendViaGmail(
  creds: GmailCredentials,
  mail: { to: string; subject: string; html: string; text: string }
): Promise<EmailSendResult> {
  try {
    await gmailTransportFor(creds).sendMail({
      from: { name: SENDER_NAME, address: creds.user },
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    return { ok: true };
  } catch (err) {
    console.error("[email] Gmail recusou o envio:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "provider_error" };
  }
}

/**
 * Envia o link de confirmação. Nunca lança: o cadastro já foi criado e a tela oferece
 * "Reenviar e-mail" quando o provedor está fora ou sem credenciais configuradas.
 */
export async function sendVerificationEmail(opts: {
  to: string;
  name: string;
  clinicName: string;
  url: string;
}): Promise<EmailSendResult> {
  const gmail = gmailCredentials();
  const apiKey = resendApiKey();

  const name = escapeHtml(opts.name);
  const clinicName = escapeHtml(opts.clinicName);
  const url = escapeHtml(opts.url);
  const subject = `Confirme seu e-mail — ${opts.clinicName}`;

  const html = `
  <div style="background:#f4f4f5;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#18181b">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <div style="font-size:22px;font-weight:700;margin-bottom:4px">Bela Agenda</div>
      <p style="color:#a16207;font-size:12px;margin:0 0 24px;text-transform:uppercase;letter-spacing:.08em">
        Confirmação de e-mail
      </p>
      <h1 style="font-size:20px;margin:0 0 16px">Confirme seu e-mail para liberar o acesso</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 12px">Olá, ${name}!</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 12px">
        Recebemos o cadastro da clínica <strong>${clinicName}</strong>. Clique no botão abaixo
        para confirmar este e-mail e poder entrar no painel.
      </p>
      <p style="margin:28px 0">
        <a href="${url}" style="display:inline-block;background:#d4a24e;color:#18181b;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:8px">
          Confirmar meu e-mail
        </a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#52525b;margin:0 0 8px">
        O link vale por 24 horas. Se ele expirar, é só pedir outro na tela de entrada.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#52525b;margin:0">
        Se você não fez este cadastro, ignore esta mensagem — nenhuma conta será ativada.
      </p>
    </div>
  </div>`;

  const text = [
    `Olá, ${opts.name}!`,
    "",
    `Confirme o e-mail do cadastro da clínica ${opts.clinicName} para liberar o acesso ao Bela Agenda:`,
    opts.url,
    "",
    "O link vale por 24 horas. Se você não fez este cadastro, ignore esta mensagem.",
  ].join("\n");

  if (gmail) {
    return sendViaGmail(gmail, { to: opts.to, subject, html, text });
  }

  if (!apiKey) {
    // Sem provedor configurado: o cadastro continua válido e o operador pode reenviar depois.
    // Em desenvolvimento imprimimos o link para conseguir testar o fluxo sem e-mail.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[email] Nenhum provedor configurado (GMAIL_USER/GMAIL_APP_PASSWORD ou RESEND_API_KEY). Link de confirmação (dev): ${opts.url}`
      );
    } else {
      console.error("[email] Nenhum provedor configurado: nenhum e-mail de confirmação foi enviado.");
    }
    return { ok: false, reason: "not_configured" };
  }

  const from = process.env.EMAIL_FROM || "Bela Agenda <onboarding@resend.dev>";

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [opts.to],
        subject,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[email] Resend recusou o envio (${res.status}): ${detail.slice(0, 300)}`);
      return { ok: false, reason: "provider_error" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[email] Falha de rede ao enviar confirmação:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "provider_error" };
  }
}
