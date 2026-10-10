import "../src/lib/load-env";
import pg from "pg";
import { closePool, pool } from "../src/lib/db";
import { env } from "../src/lib/env";
import { TEMPLATES } from "../src/server/messaging/templates";

/**
 * Go-live check (blueprint section AL), as something you run rather than a list you read.
 *
 *   npx tsx scripts/preflight.ts
 *
 * Every line is something that has bitten a real deployment: a migration not applied, a
 * worker that was never started, demo credentials left in place, a webhook with no secret.
 */

type Level = "pass" | "warn" | "fail";
const results: { level: Level; label: string; detail: string }[] = [];

const pass = (label: string, detail = "") => results.push({ level: "pass", label, detail });
const warn = (label: string, detail: string) => results.push({ level: "warn", label, detail });
const fail = (label: string, detail: string) => results.push({ level: "fail", label, detail });

async function main(): Promise<void> {
  let e: ReturnType<typeof env>;
  try {
    e = env();
    pass("Configuration", "every required setting is present and valid");
  } catch (err) {
    fail("Configuration", (err as Error).message.replace(/\n/g, " "));
    report();
    return;
  }

  // --- database ---
  try {
    await pool().query("SELECT 1");
    pass("Database", "reachable");

    const applied = await pool().query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(new URL("../migrations", import.meta.url))).filter((f) => f.endsWith(".sql")).sort();
    const missing = files.filter((f) => !applied.rows.some((r) => r.name === f));
    if (missing.length) fail("Migrations", `not applied: ${missing.join(", ")} — run npm run db:migrate`);
    else pass("Migrations", `${applied.rowCount} applied, none pending`);
  } catch (err) {
    fail("Database", (err as Error).message);
  }

  // --- the worker must actually be running, or nothing happens at all ---
  try {
    const hb = await pool().query<{ last_seen: Date | null }>(`SELECT max(last_seen) AS last_seen FROM worker_heartbeats`);
    const lastSeen = hb.rows[0]?.last_seen;
    if (!lastSeen) fail("Worker", "has never run — start nit-worker before going live");
    else {
      const ageSeconds = Math.round((Date.now() - new Date(lastSeen).getTime()) / 1000);
      if (ageSeconds > 60) fail("Worker", `last heartbeat ${ageSeconds}s ago — it is not running`);
      else pass("Worker", `heartbeat ${ageSeconds}s ago`);
    }

    const dead = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'dead'`);
    if (dead.rows[0]!.n > 0) warn("Job queue", `${dead.rows[0]!.n} dead job(s) — check the exceptions page`);
    else pass("Job queue", "no dead jobs");
  } catch {
    // Database already reported as failed.
  }

  // --- messaging ---
  if (e.MESSAGING_PROVIDER === "mock") {
    warn("Messaging", "still on the demo phone — patients will receive nothing");
  } else {
    pass("Messaging", `WhatsApp Cloud API, phone number id ${e.WA_PHONE_NUMBER_ID?.slice(0, 6)}…`);
    if (!e.WA_APP_SECRET) fail("Inbound webhook", "WA_APP_SECRET is not set: delivery receipts cannot be trusted");
    else pass("Inbound webhook", "signature verification is on");
    if (!e.WA_VERIFY_TOKEN) warn("Inbound webhook", "WA_VERIFY_TOKEN is not set: Meta cannot register the webhook");
  }

  const templateNames = Object.values(TEMPLATES).map((t) => t.providerName);
  warn("WhatsApp templates", `confirm these are approved in WhatsApp Manager: ${templateNames.join(", ")}`);

  // --- AI ---
  if (e.AI_PROVIDER === "rules") warn("AI", "rules engine only — fine, but classification will be simpler");
  else pass("AI", `${e.AI_MODEL} with a rules fallback`);

  // --- security ---
  try {
    const admins = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM staff_users WHERE role = 'admin' AND active`);
    const everyone = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM staff_users WHERE active`);
    if (admins.rows[0]!.n === 0) fail("Staff console", "no active administrator — create one with npm run user:create");
    else pass("Staff console", `${everyone.rows[0]!.n} active account(s), ${admins.rows[0]!.n} administrator(s)`);
  } catch {
    /* reported above */
  }

  if (!e.WEBHOOK_SECRET) warn("Lead webhook", "WEBHOOK_SECRET is not set: anyone can post leads");
  else pass("Lead webhook", "shared secret required");

  if (e.PUBLIC_BASE_URL.startsWith("http://") && !e.PUBLIC_BASE_URL.includes("localhost")) {
    fail("Public URL", `${e.PUBLIC_BASE_URL} is not HTTPS — patient links would travel in the clear`);
  } else pass("Public URL", e.PUBLIC_BASE_URL);

  if (/nit_dev_only|change-me|password/i.test(e.DATABASE_URL)) {
    fail("Database password", "still a development password — change it before go-live");
  }

  // --- retention ---
  if (e.RETENTION_ENABLED) {
    pass("Retention", `messages redacted after ${e.RETENTION_MESSAGE_DAYS} days, enquiries after ${e.RETENTION_ENQUIRY_DAYS}`);
  } else {
    warn("Retention", "disabled — confirm the hospital's own policy covers this");
  }

  // --- demo data must not reach production ---
  try {
    const demo = await pool().query<{ n: number }>(`SELECT count(*)::int AS n FROM patients WHERE source = 'demo'`);
    if (demo.rows[0]!.n > 0) fail("Demo data", `${demo.rows[0]!.n} demo patients present — clear them before go-live`);
    else pass("Demo data", "none");
  } catch {
    /* reported above */
  }

  report();
}

function report(): void {
  const icon = { pass: "  ok ", warn: " warn", fail: " FAIL" };
  console.log("\nGo-live check\n");
  for (const r of results) {
    console.log(`${icon[r.level]}  ${r.label.padEnd(20)} ${r.detail}`);
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(
    `\n${results.length - fails - warns} passed, ${warns} to confirm, ${fails} blocking.` +
      (fails ? "\nDo not go live until the blocking items are fixed.\n" : "\n"),
  );
  process.exitCode = fails ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
    void pg;
  });
