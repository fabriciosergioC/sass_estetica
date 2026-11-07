import type { NextRequest } from "next/server";
import { HttpError, requirePermission } from "@/lib/auth/guards";
import { jsonOk, handleApiError } from "@/lib/api";
import { MAX_RANGE_DAYS, parseLocalDate, type Granularity } from "@/lib/period";
import { getRevenueReport } from "@/modules/reports/revenue";

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

/**
 * GET /api/reports/revenue?granularity=day|week|month&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Faturamento e atendimentos do período, com o comparativo do período imediatamente anterior
 * (mesma duração). É a rota por trás do filtro de período da tela de Relatórios.
 *
 * Tudo sai em CENTAVOS (Int), como no resto do banco — quem formata R$ é a tela. O `orgId`
 * vem da sessão e entra em TODA consulta: relatório não pode ver o caixa de outra barbearia.
 */
export async function GET(req: NextRequest) {
  try {
    const { orgId } = await requirePermission("reports:view");
    const params = req.nextUrl.searchParams;

    const rawGranularity = params.get("granularity") ?? "month";
    if (!GRANULARITIES.includes(rawGranularity as Granularity)) {
      throw new HttpError(400, "Período inválido: use dia, semana ou mês.");
    }
    const granularity = rawGranularity as Granularity;

    const from = parseLocalDate(params.get("from"));
    const to = parseLocalDate(params.get("to"));
    if (!from || !to) throw new HttpError(400, "Informe as datas inicial e final no formato AAAA-MM-DD.");
    if (from.getTime() > to.getTime()) throw new HttpError(400, "A data inicial não pode vir depois da final.");

    const days = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new HttpError(400, `Período muito longo: mostre no máximo ${MAX_RANGE_DAYS} dias por vez.`);
    }

    const report = await getRevenueReport({ orgId, granularity, from, to });
    return jsonOk(report);
  } catch (err) {
    return handleApiError(err);
  }
}
