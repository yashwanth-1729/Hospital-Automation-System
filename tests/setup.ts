import { config } from "dotenv";
import { afterAll } from "vitest";

config({ quiet: true });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// Tests are hermetic: deterministic providers unless a test injects its own.
process.env.AI_PROVIDER = "rules";
process.env.MESSAGING_PROVIDER = "mock";
// Keep dotenv from reloading an operator's demo allowlist into fake-provider tests.
process.env.WA_ALLOWED_RECIPIENTS = "";
process.env.HOSPITAL_NAME = "DemoCare Multispeciality Hospital";
process.env.HOSPITAL_CONTACT = "+91 80000 00000";

afterAll(async () => {
  const { closePool } = await import("@/lib/db");
  await closePool();
});
