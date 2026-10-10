import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const get = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) =>
  new NextRequest(`https://care.example.com${path}`, init);
const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
const withSession = { headers: { cookie: "nit_session=abc123" } };

let savedUrl: string | undefined;

beforeEach(() => {
  savedUrl = process.env.DATABASE_URL;
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
});

describe("with no database attached (a preview host)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  it.each(["/", "/leads", "/enquiry", "/login", "/r/some-token", "/reports"])("explains itself at %s instead of crashing", async (path) => {
    const res = proxy(get(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toContain("no database attached");
  });

  it("treats an empty DATABASE_URL the same as a missing one", async () => {
    process.env.DATABASE_URL = "";
    expect(await proxy(get("/")).text()).toContain("no database attached");
  });

  it("answers health checks and webhooks with a clear 503, not a page", async () => {
    for (const path of ["/api/health", "/api/webhooks/whatsapp", "/api/webhooks/lead"]) {
      const res = proxy(get(path));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, database: false, error: "not_configured" });
    }
  });

  it("refuses a form post rather than pretending it was accepted", async () => {
    const res = proxy(get("/enquiry", { method: "POST" }));
    expect(res.status).toBe(503);
  });
});

describe("with a database attached", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  });

  it("sends signed-out visitors to the sign-in page, remembering where they were going", () => {
    const res = proxy(get("/appointments"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/appointments");
  });

  it("does not add a next parameter for the home page", () => {
    const location = new URL(proxy(get("/")).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.has("next")).toBe(false);
  });

  it("redirects every staff page when there is no session cookie", () => {
    for (const path of ["/", "/leads", "/reports", "/audits", "/exceptions", "/admin/users", "/account"]) {
      expect(proxy(get(path)).status, path).toBe(307);
    }
  });

  it("refuses an unauthenticated post with 401 rather than redirecting it", async () => {
    const res = proxy(get("/appointments", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "unauthenticated" });
  });

  it("lets a request carrying a session cookie through to be verified by the page", () => {
    for (const path of ["/", "/leads", "/admin/users"]) {
      expect(passesThrough(proxy(get(path, withSession))), path).toBe(true);
    }
  });

  it("does not let a path that merely starts with a public prefix skip sign-in", () => {
    // "/reports" begins with "r" and must stay protected; only "/r/<token>" is public.
    expect(proxy(get("/reports")).status).toBe(307);
    expect(proxy(get("/enquiry-admin")).status).toBe(307);
    expect(proxy(get("/login-help")).status).toBe(307);
    // An API path gets a machine-readable 401, not a redirect to an HTML page.
    expect(proxy(get("/api/healthcheck-internal")).status).toBe(401);
  });

  it("leaves sign-in, patient-facing pages and signed webhooks public", () => {
    for (const path of ["/login", "/no-access", "/enquiry", "/r/abc123", "/api/webhooks/whatsapp", "/api/webhooks/lead", "/api/health"]) {
      expect(passesThrough(proxy(get(path))), path).toBe(true);
    }
  });
});
