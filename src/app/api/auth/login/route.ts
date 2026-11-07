import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { handleApiError } from "@/lib/api";

const schema = z.object({
  email: z.string().email("E-mail inválido").toLowerCase(),
  password: z.string().min(1, "Informe a senha"),
});

export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());

    const user = await db.user.findUnique({
      where: { email: body.email },
      include: {
        memberships: {
          where: { status: "ACTIVE" },
          include: { org: { select: { id: true, name: true, status: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    // Mensagem genérica: não revelar se o e-mail existe
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return NextResponse.json({ error: "E-mail ou senha incorretos." }, { status: 401 });
    }

    const activeMembership = user.memberships.find((m) => m.org.status === "ACTIVE") ?? user.memberships[0];

    // Cacheia memberships e nome da org na sessão para evitar queries no banco
    const cachedMemberships = user.memberships.map((m) => ({
      orgId: m.orgId,
      orgName: m.org.name,
      role: m.role,
    }));

    await setSessionCookie({
      userId: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: user.isSuperAdmin,
      tokenVersion: user.tokenVersion,
      activeOrgId: activeMembership?.orgId,
      role: activeMembership?.role,
      cachedOrgName: activeMembership?.org.name,
      cachedMemberships,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
