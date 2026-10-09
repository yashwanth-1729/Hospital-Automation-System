import { NextResponse, type NextRequest } from "next/server";
import { HOLDING_PAGE } from "@/lib/holding-page";

/**
 * Runs before every page and API route.
 *
 * 1. With no database configured (a preview host such as Vercel), show a plain explanation
 *    instead of letting every page crash with a 500.
 * 2. Otherwise, optional HTTP basic auth for the staff console (user "admin", password
 *    DASHBOARD_PASSWORD). The patient form, feedback links, the webhooks (which verify their
 *    own secret or signature) and the health check stay public.
 */

const PUBLIC_PATHS = ["/enquiry", "/r/", "/api/webhooks/", "/api/health"];

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
  if (isPublic(req.nextUrl.pathname)) return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":"); // Passwords may contain ':'; the username may not.
    if (decoded.slice(0, sep) === "admin" && decoded.slice(sep + 1) === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="NIT Care Ops"' },
  });
}

export const config = {
  // Everything except Next's own static assets: the no-database check must cover public pages too.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
