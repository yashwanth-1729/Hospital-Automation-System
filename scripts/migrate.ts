import "../src/lib/load-env";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/**
 * Applies migrations/*.sql in filename order, each in its own transaction.
 * --reset drops everything first (refused when NODE_ENV=production).
 */
export async function migrate(connectionString: string, opts: { reset?: boolean; quiet?: boolean } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const log = (m: string) => !opts.quiet && console.log(m);
  try {
    if (opts.reset) {
      if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      log("database reset");
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const applied = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const dir = path.resolve(import.meta.dirname, "..", "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    log("migrations up to date");
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(url, { reset: process.argv.includes("--reset") }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
