import { NextResponse, type NextRequest } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth/session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/app/barbeiros" || pathname.startsWith("/app/barbeiros/")) {
    const url = req.nextUrl.clone();
    url.pathname = pathname.replace("/app/barbeiros", "/app/estetica");
    url.search = req.nextUrl.search;
    return NextResponse.redirect(url, 308);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  // Painel exige sessão
  if (pathname.startsWith("/app") && !session) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Painel da plataforma exige super admin
  if (pathname.startsWith("/admin") && session && !session.isSuperAdmin) {
    return NextResponse.redirect(new URL("/app", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/admin/:path*"],
};
