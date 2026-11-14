import { NextRequest, after } from "next/server";
import { z } from "zod";
import { jsonOk, handleApiError } from "@/lib/api";
import { requirePermission } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import {
  listStuckSends,
  requeueStuckProcessing,
  retryStuckSends,
  reviveDeadJobs,
} from "@/modules/whatsapp/queue-stuck";

/**
 * /api/whatsapp/queue/stuck — diagnóstico e recuperação da fila travada (§26).
 *
 * GET classifica o que está parado: mensagem sem job, job morto, job vencido, mensagem com
 * erro, job órfão em PROCESSING. POST devolve para a fila pelo MESMO caminho de envio —
 * espaçado e sujeito a pausa, limite por hora, bloqueio e opt-out. Nada aqui manda mensagem
 * por fora da fila, e nada antecipa lembrete agendado para o futuro.
 */

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await requirePermission("whatsapp:manage");
    return jsonOk(await listStuckSends(orgId));
  } catch (err) {
    return handleApiError(err);
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    ids: z.array(z.string().min(1)).min(1).max(25),
  }),
  z.object({
    action: z.literal("retry_all"),
    scope: z.enum(["queued", "failed", "all"]).default("all"),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  z.object({
    action: z.literal("revive_jobs"),
    ids: z.array(z.string().min(1)).min(1).max(25),
  }),
  z.object({
    action: z.literal("revive_all_jobs"),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  z.object({ action: z.literal("requeue_processing") }),
]);

export async function POST(req: NextRequest) {
  try {
    const { orgId, session } = await requirePermission("whatsapp:manage");
    const body = postSchema.parse(await req.json());

    let result: unknown;
    let auditAction: string;
    let kickWorker = false;

    switch (body.action) {
      case "retry":
        result = await retryStuckSends(orgId, { ids: body.ids, scope: "all", by: session.userId });
        auditAction = "whatsapp.queue.stuck.retry";
        kickWorker = true;
        break;

      case "retry_all":
        result = await retryStuckSends(orgId, {
          scope: body.scope,
          limit: body.limit,
          by: session.userId,
        });
        auditAction = "whatsapp.queue.stuck.retry_all";
        kickWorker = true;
        break;

      case "revive_jobs":
        result = await reviveDeadJobs(orgId, { ids: body.ids, by: session.userId });
        auditAction = "whatsapp.queue.stuck.revive";
        kickWorker = true;
        break;

      case "revive_all_jobs":
        result = await reviveDeadJobs(orgId, { limit: body.limit, by: session.userId });
        auditAction = "whatsapp.queue.stuck.revive_all";
        kickWorker = true;
        break;

      case "requeue_processing":
        result = await requeueStuckProcessing(orgId, { by: session.userId });
        auditAction = "whatsapp.queue.stuck.requeue_processing";
        kickWorker = true;
        break;

      default: {
        // Exaustividade do discriminated union: se um dia entrar uma ação nova sem caso,
        // o TypeScript aponta aqui em vez de deixar a rota responder vazio.
        const unreachable: never = body;
        return jsonOk({ error: `Ação não reconhecida: ${JSON.stringify(unreachable)}` }, 400);
      }
    }

    // O enfileiramento não espera o worker; aqui só damos o empurrão inicial para o primeiro
    // item sair logo. Os demais seguem a escada de `runAt` normalmente. Acordar (em vez de
    // rodar um lote fixo) faz o agendador dormir só até o próximo vencimento — os itens
    // reenviados não esperam mais o tique longo de segurança.
    if (kickWorker) {
      try {
        after(async () => {
          const { wakeJobWorker } = await import("@/modules/automation/worker");
          wakeJobWorker();
        });
      } catch {
        // fora de contexto de requisição: o agendador pega no próximo vencimento
      }
    }

    await db.auditLog
      .create({
        data: {
          orgId,
          userId: session.userId,
          action: auditAction,
          entity: "whatsapp_queue",
          after: JSON.stringify(result).slice(0, 4000),
        },
      })
      .catch(() => {});

    return jsonOk({ result, snapshot: await listStuckSends(orgId) });
  } catch (err) {
    return handleApiError(err);
  }
}
