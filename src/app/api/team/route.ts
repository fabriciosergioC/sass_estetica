import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { handleApiError, jsonOk } from "@/lib/api";

const roleSchema = z.enum(["ADMIN", "MANAGER", "RECEPTIONIST", "BARBER"], {
  message: "Papel inválido.",
});

/** Login novo para a clínica ativa. */
const createSchema = z.object({
  name: z.string().min(2, "Informe o nome").max(80),
  email: z.string().email("E-mail inválido").toLowerCase(),
  password: z.string().min(8, "A senha precisa ter ao menos 8 caracteres").max(72),
  role: roleSchema,
});

/** Pessoa que já tem login na plataforma: só ganha vínculo com esta clínica. */
const linkSchema = z.object({
  userId: z.string().min(1, "Escolha o usuário"),
  role: roleSchema,
});

/**
 * Usuários da clínica ativa. Só ADMIN enxerga e mexe (matriz em lib/auth/permissions).
 * O superadmin que trocou para a empresa entra com papel ADMIN, então também passa aqui.
 */
export async function GET() {
  try {
    const { orgId } = await requirePermission("org:manage");
    const members = await db.organizationMember.findMany({
      where: { orgId },
      include: {
        user: { select: { id: true, name: true, email: true, isSuperAdmin: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });

    return jsonOk({
      items: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        isSuperAdmin: m.user.isSuperAdmin,
        role: m.role,
        status: m.status,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("org:manage");
    const raw = await req.json().catch(() => ({}));

    const link = linkSchema.safeParse(raw);
    if (link.success) {
      return await linkExistingUser(orgId, session.userId, link.data);
    }

    const body = createSchema.parse(raw);
    const existing = await db.user.findUnique({
      where: { email: body.email },
      select: { id: true, name: true },
    });
    if (existing) {
      // Não criamos um segundo login para o mesmo e-mail. A tela oferece vincular a pessoa
      // que já existe à clínica, sem mexer na senha dela.
      return jsonOk(
        {
          error: "Este e-mail já tem login na plataforma.",
          existingUser: existing,
        },
        409
      );
    }

    const passwordHash = await hashPassword(body.password);
    const { user, member } = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: body.email, passwordHash, name: body.name },
      });
      const member = await tx.organizationMember.create({
        data: { orgId, userId: user.id, role: body.role, status: "ACTIVE" },
      });
      return { user, member };
    });

    await audit(orgId, session.userId, "team.create", member.id, {
      email: user.email,
      role: body.role,
    });

    return jsonOk(
      {
        ok: true,
        item: {
          id: member.id,
          userId: user.id,
          name: user.name,
          email: user.email,
          isSuperAdmin: false,
          role: member.role,
          status: member.status,
          createdAt: member.createdAt,
        },
      },
      201
    );
  } catch (err) {
    return handleApiError(err);
  }
}

async function linkExistingUser(
  orgId: string,
  actorUserId: string,
  body: { userId: string; role: string }
) {
  const user = await db.user.findUnique({
    where: { id: body.userId },
    select: { id: true, name: true, email: true, isSuperAdmin: true },
  });
  if (!user) return jsonOk({ error: "Usuário não encontrado." }, 404);

  const already = await db.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId: user.id } },
  });
  if (already) {
    return jsonOk({ error: "Esta pessoa já tem acesso a esta clínica." }, 409);
  }

  const member = await db.organizationMember.create({
    data: { orgId, userId: user.id, role: body.role, status: "ACTIVE" },
  });

  await audit(orgId, actorUserId, "team.link", member.id, {
    email: user.email,
    role: body.role,
  });

  return jsonOk(
    {
      ok: true,
      item: {
        id: member.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        isSuperAdmin: user.isSuperAdmin,
        role: member.role,
        status: member.status,
        createdAt: member.createdAt,
      },
    },
    201
  );
}

async function audit(
  orgId: string,
  userId: string,
  action: string,
  entityId: string,
  after: Record<string, unknown>
) {
  try {
    await db.auditLog.create({
      data: {
        orgId,
        userId,
        action,
        entity: "organization_member",
        entityId,
        after: JSON.stringify(after),
      },
    });
  } catch (err) {
    console.error("[team] não foi possível auditar", err);
  }
}
