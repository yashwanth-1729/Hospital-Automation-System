import { config } from "dotenv";
import { migrate } from "../scripts/migrate";

/** Rebuilds the test database schema once per test run. */
export default async function setup() {
  config({ quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL must be set to run tests");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL");
  await migrate(url, { reset: true, quiet: true });
}
