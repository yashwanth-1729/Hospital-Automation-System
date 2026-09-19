import { audit } from "@/lib/audit";
import { pool } from "@/lib/db";
import { raiseException } from "@/lib/exceptions";
import { claimJobs, completeJob, failJob, reapStaleJobs, type Job } from "@/lib/jobs";
import { MessagingError } from "@/server/messaging/providers";
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

export async function heartbeat(workerId: string, info: Record<string, unknown>) {
  await pool().query(
    `INSERT INTO worker_heartbeats (worker_id, last_seen, info) VALUES ($1, now(), $2)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(), info = EXCLUDED.info`,
    [workerId, info],
  );
}

export { reapStaleJobs };
