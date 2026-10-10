import { NextResponse, type NextRequest } from "next/server";
import { HOLDING_PAGE } from "@/lib/holding-page";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Runs before every page and API route.
 *
 * 1. With no database configured (a preview host such as Vercel), show a plain explanation
 *    instead of letting every page crash with a 500.
 * 2. Otherwise, send people without a session cookie to the sign-in page. This is only a
 *    courtesy redirect: whether the cookie is genuine, and what its owner may do, is decided
 *    by `requireStaff()` against the database on every page and action.
 *
 * The patient form, feedback links, sign-in, the webhooks (which verify their own secret or
 * signature) and the health check are public.
 */

const PUBLIC_PATHS = ["/login", "/no-access", "/enquiry", "/r/", "/api/webhooks/", "/api/health"];

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));
}

function notConnected(req: NextRequest): NextResponse {
  const path = req.nextUrl.pathname;
  const isPageRequest = req.method === "GET" || req.method === "HEAD";

  if (isPageRequest && !path.startsWith("/api/")) {
    return new NextResponse(HOLDING_PAGE, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  // Anything that is not a person opening a page, including health checks and form posts,
  // gets an honest machine-readable failure rather than a page they cannot use.
  return NextResponse.json(
    { ok: false, database: false, error: "not_configured", message: "No database is attached to this deployment." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export function proxy(req: NextRequest) {
  if (!process.env.DATABASE_URL) return notConnected(req);

  const path = req.nextUrl.pathname;
  if (isPublic(path)) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  if ((req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/")) {
    const login = new URL("/login", req.url);
    if (path !== "/") login.searchParams.set("next", path + req.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401, headers: { "cache-control": "no-store" } });
}

export const config = {
  // Everything except Next's own static assets: the no-database check must cover public pages too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
