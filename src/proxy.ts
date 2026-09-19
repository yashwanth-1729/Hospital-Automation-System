import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional HTTP basic auth for the staff console (user "admin", password DASHBOARD_PASSWORD).
 * The patient form, the webhook (which has its own secret) and the health check stay public.
 */
export function proxy(req: NextRequest) {
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
  matcher: ["/((?!enquiry|r/|api/webhooks|api/health|_next/static|_next/image|favicon.ico).*)"],
};
