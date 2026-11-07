import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "./auth/guards";
import { BusinessError } from "@/modules/scheduling/appointments";

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * Converte erros em respostas amigáveis; detalhes técnicos só no log do servidor.
 *
 * `extraHeaders` é para as rotas públicas (agendamento por link), que precisam devolver CORS
 * também na resposta de erro. Sem isso o navegador não consegue ler o `{ error }` — a página
 * fica com "Failed to fetch" e o barbeiro não sabe o que houve.
 */
export function handleApiError(err: unknown, extraHeaders?: Record<string, string>) {
  const json = (body: unknown, status: number) =>
    NextResponse.json(body, { status, headers: extraHeaders });

  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status);
  }
  if (err instanceof BusinessError) {
    return json({ error: err.message }, 400);
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return json({ error: first ? `${first.path.join(".")}: ${first.message}` : "Dados inválidos." }, 400);
  }
  console.error("[api]", err);
  return json({ error: "Não foi possível concluir esta ação. Tente novamente." }, 500);
}

export function parsePagination(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize") ?? 20) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
