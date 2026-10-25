import { audit } from "@/lib/audit";
import { pool } from "@/lib/db";
import { raiseException } from "@/lib/exceptions";
import { claimJobs, completeJob, failJob, reapStaleJobs, type Job } from "@/lib/jobs";
import { MessagingError } from "@/server/messaging/providers";
import { sweepNoShows } from "@/server/workflows/no-show";
import { runRetention } from "@/server/workflows/retention";
import { sweepCare } from "@/server/care/care";
import { sweepLabs } from "@/server/care/labs";
import { TemplateError } from "@/server/messaging/templates";
import { getHandler, PermanentJobError } from "./handlers";

function isPermanent(err: unknown): boolean {
  return (
    err instanceof PermanentJobError ||
    err instanceof TemplateError ||
    (err instanceof MessagingError && err.permanent)
  );
}

/** Runs one claimed job and records the outcome. Never throws. */
export async function runJob(job: Job): Promise<"done" | "queued" | "dead"> {
  const db = pool();
  try {
    await getHandler(job.type)(job.payload, { correlationId: job.correlation_id });
    await completeJob(db, job.job_id);
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = await failJob(db, job, message, isPermanent(err));
    if (status === "dead") {
      await raiseException(db, {
        workflow: "system",
        errorType: "JOB_FAILED",
        severity: "high",
        summary: `Automation step '${job.type}' failed after ${job.attempts} attempt(s): ${message.slice(0, 200)}`,
        recordId: String(job.job_id),
        correlationId: job.correlation_id,
        owner: "it_admin",
        details: { job_type: job.type, payload: job.payload, error: message },
        dedupeKey: `job-dead:${job.job_id}`,
      }).catch(() => {});
      await audit(db, {
        workflow: "system",
        actor: "system",
        action: "job.dead",
        recordId: String(job.job_id),
        correlationId: job.correlation_id,
        details: { type: job.type, error: message },
      }).catch(() => {});
    }
    return status;
  }
}

/** Claims and runs one batch of due jobs. Returns how many ran. */
export async function runOnce(workerId: string, batchSize = 5): Promise<number> {
  const jobs = await claimJobs(pool(), workerId, batchSize);
  await Promise.all(jobs.map(runJob));
  return jobs.length;
}

/** Runs due jobs until the queue is empty. Used by tests and the demo "process now" action. */
export async function drain(workerId = "drain", maxRounds = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await runOnce(workerId, 10);
    if (n === 0) break;
    total += n;
  }
  return total;
}

/**
 * Periodic scan for missed appointments. An advisory lock keeps exactly one worker
 * sweeping at a time; the sweep itself is idempotent either way.
 */
export async function sweepOnce(): Promise<string[]> {
  const db = pool();
  const lock = await db.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext('noshow_sweep')) AS locked`);
  if (!lock.rows[0]?.locked) return [];
  try {
    return await sweepNoShows();
  } finally {
    await db.query(`SELECT pg_advisory_unlock(hashtext('noshow_sweep'))`);
  }
}

/**
 * Daily retention purge. Advisory-locked so only one worker runs it, and idempotent by day
 * so a restart cannot run it twice.
 */
export async function retentionOnce(): Promise<number> {
  const db = pool();
  const lock = await db.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext('retention')) AS locked`);
  if (!lock.rows[0]?.locked) return 0;
  try {
    const result = await runRetention();
    return result.messagesRedacted + result.enquiriesCleared + result.inboundCleared;
  } finally {
    await db.query(`SELECT pg_advisory_unlock(hashtext('retention'))`);
  }
}

/** Chronic care recalls and lab review chasing. Both are idempotent; the lock just avoids double work. */
export async function careOnce(): Promise<{ reminded: number; escalated: number; labs: number }> {
  const db = pool();
  const lock = await db.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext('care_sweep')) AS locked`);
  if (!lock.rows[0]?.locked) return { reminded: 0, escalated: 0, labs: 0 };
  try {
    const care = await sweepCare();
    const labs = await sweepLabs();
    return { ...care, labs };
  } finally {
    await db.query(`SELECT pg_advisory_unlock(hashtext('care_sweep'))`);
  }
}

export async function heartbeat(workerId: string, info: Record<string, unknown>) {
  await pool().query(
    `INSERT INTO worker_heartbeats (worker_id, last_seen, info) VALUES ($1, now(), $2)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(), info = EXCLUDED.info`,
    [workerId, info],
  );
}

export { reapStaleJobs };
