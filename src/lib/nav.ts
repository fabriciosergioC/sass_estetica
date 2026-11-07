/**
 * Rota do painel que mostra o link de agendamento exatamente como o cliente vê.
 *
 * É a única tela de `/app` desenhada em tela cheia, sem sidebar. `sidebar.tsx` e
 * `app-layout-shell.tsx` precisam concordar sobre qual é esse caminho: enquanto a topbar mobile
 * era renderizada fora da mesma condição do `<aside>`, o hambúrguer aparecia nesta tela e abria
 * um menu que não existe nela.
 */
export const BOOKING_PREVIEW_PATH = "/app/agendamento-cliente";

export function isBookingPreview(pathname: string | null | undefined): boolean {
  return pathname === BOOKING_PREVIEW_PATH;
}
