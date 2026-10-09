import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const get = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) =>
  new NextRequest(`https://care.example.com${path}`, init);
const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

let savedUrl: string | undefined;
let savedPassword: string | undefined;

beforeEach(() => {
  savedUrl = process.env.DATABASE_URL;
  savedPassword = process.env.DASHBOARD_PASSWORD;
});

afterEach(() => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  if (savedPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = savedPassword;
});

describe("with no database attached (a preview host)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  it.each(["/", "/leads", "/enquiry", "/r/some-token", "/reports"])("explains itself at %s instead of crashing", async (path) => {
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

  it("shows the same static page whether or not a dashboard password is set", async () => {
    // The page is static and holds no data, so there is nothing to protect behind a login.
    process.env.DASHBOARD_PASSWORD = "secret";
    const res = proxy(get("/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("no database attached");
  });
});

describe("with a database attached", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
  });

  it("does nothing when no dashboard password is set", () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(passesThrough(proxy(get("/")))).toBe(true);
  });

  it("asks for a password on staff pages when one is set", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    for (const path of ["/", "/leads", "/reports", "/audits", "/exceptions"]) {
      const res = proxy(get(path));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/Basic/);
    }
  });

  it("does not let a path that merely starts with 'r' or 'enquiry' skip the password", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    // "/reports" begins with "r" and must stay protected; only "/r/<token>" is public.
    expect(proxy(get("/reports")).status).toBe(401);
    expect(proxy(get("/enquiry-admin")).status).toBe(401);
    expect(proxy(get("/api/healthcheck-internal")).status).toBe(401);
  });

  it("leaves patient-facing pages and signed webhooks public", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    for (const path of ["/enquiry", "/r/abc123", "/api/webhooks/whatsapp", "/api/webhooks/lead", "/api/health"]) {
      expect(passesThrough(proxy(get(path))), path).toBe(true);
    }
  });

  it("lets staff in with the right password, including one containing a colon", () => {
    process.env.DASHBOARD_PASSWORD = "se:cret";
    const auth = `Basic ${Buffer.from("admin:se:cret").toString("base64")}`;
    expect(passesThrough(proxy(get("/", { headers: { authorization: auth } })))).toBe(true);
  });

  it("keeps out the wrong password and the wrong user", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const wrongPassword = `Basic ${Buffer.from("admin:nope").toString("base64")}`;
    const wrongUser = `Basic ${Buffer.from("root:secret").toString("base64")}`;
    expect(proxy(get("/", { headers: { authorization: wrongPassword } })).status).toBe(401);
    expect(proxy(get("/", { headers: { authorization: wrongUser } })).status).toBe(401);
  });
});
