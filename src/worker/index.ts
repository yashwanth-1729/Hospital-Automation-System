import "@/lib/load-env";
import { hostname } from "node:os";
import { closePool, pool } from "@/lib/db";
import { env } from "@/lib/env";
import { heartbeat, reapStaleJobs, retentionOnce, runOnce, sweepOnce } from "./runner";

const POLL_MS = 1000;
const HEARTBEAT_MS = 10_000;
const REAP_MS = 60_000;
const SWEEP_MS = 60_000;
const RETENTION_MS = 3_600_000; // hourly check; the purge itself runs once a day

const workerId = `${hostname()}:${process.pid}`;
let stopping = false;

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), worker: workerId, msg, ...extra }));
}

async function main() {
  const e = env(); // Fail fast on bad configuration.
  await pool().query("SELECT 1");
  log("worker started", { ai: e.AI_PROVIDER, messaging: e.MESSAGING_PROVIDER });

  const info = { ai: e.AI_PROVIDER, messaging: e.MESSAGING_PROVIDER, pid: process.pid };
  let lastHeartbeat = 0;
  let lastReap = 0;
  let lastSweep = 0;
  let lastRetention = 0;

  while (!stopping) {
    const now = Date.now();
    try {
      if (now - lastHeartbeat > HEARTBEAT_MS) {
        await heartbeat(workerId, info);
        lastHeartbeat = now;
      }
      if (now - lastReap > REAP_MS) {
        const n = await reapStaleJobs(pool());
        if (n) log("requeued stale jobs", { count: n });
        lastReap = now;
      }
      if (now - lastSweep > SWEEP_MS) {
        const missed = await sweepOnce();
        if (missed.length) log("marked no-shows", { count: missed.length });
        lastSweep = now;
      }
      if (now - lastRetention > RETENTION_MS) {
        const purged = await retentionOnce();
        if (purged) log("retention purge", { rows: purged });
        lastRetention = now;
      }
      const ran = await runOnce(workerId);
      if (ran > 0) {
        log("processed jobs", { count: ran });
        continue; // More may be waiting.
      }
    } catch (err) {
      // Database hiccup: log and keep going. Never let the loop die.
      log("worker loop error", { error: (err as Error).message });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log("worker stopped");
  await closePool();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`received ${sig}, finishing current batch`);
    stopping = true;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
