import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession, setSessionCookie } from "@/lib/auth/session";
import { HttpError } from "@/lib/auth/guards";
import { handleApiError, jsonOk } from "@/lib/api";

const schema = z.object({
  name: z.string().trim().min(2, "Informe seu nome").max(80),
});

/**
 * Nome de exibição do próprio usuário — o que aparece na sidebar ("trocar de usuário" e rodapé).
 * Não tem relação com `Organization.name`: renomear a clínica continua sendo em /api/organizations.
 *
 * O cookie de sessão guarda o nome (o layout não consulta o banco a cada navegação), por isso
 * ele é reescrito aqui — sem isso a sidebar só mostraria o nome novo no próximo login.
 */
export async function PATCH(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new HttpError(401, "Sessão expirada. Faça login novamente.");

    const body = schema.parse(await req.json());
    const user = await db.user.update({
      where: { id: session.userId },
      data: { name: body.name },
      select: { id: true, name: true, email: true },
    });

    await setSessionCookie({ ...session, name: user.name });

    return jsonOk({ ok: true, user });
  } catch (err) {
    return handleApiError(err);
  }
}
