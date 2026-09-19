import pg from "pg";
import { env } from "./env";

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
pg.types.setTypeParser(1082, (v) => v);
// bigint (e.g. bigserial ids, count(*)) as JS numbers; our values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool | pg.PoolClient;

const g = globalThis as unknown as { __nitPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__nitPool) {
    g.__nitPool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 10 });
  }
  return g.__nitPool;
}

export async function closePool() {
  if (g.__nitPool) {
    const p = g.__nitPool;
    g.__nitPool = undefined;
    await p.end();
  }
}

/** Runs fn inside a transaction; rolls back on any thrown error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

export async function many<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}
