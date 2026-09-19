import type { Db } from "./db";

export interface Job {
  job_id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
  run_at: Date;
}

export interface EnqueueOptions {
  type: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  /** A job with the same dedupe key is enqueued at most once, ever. */
  dedupeKey?: string;
  maxAttempts?: number;
  correlationId?: string | null;
}

/** Returns the new job id, or null when a job with the same dedupe key already exists. */
export async function enqueue(db: Db, o: EnqueueOptions): Promise<number | null> {
  const r = await db.query<{ job_id: number }>(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts, correlation_id)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING job_id`,
    [o.type, o.payload, o.runAt ?? null, o.dedupeKey ?? null, o.maxAttempts ?? 5, o.correlationId ?? null],
  );
  return r.rows[0]?.job_id ?? null;
}

/** Atomically claims up to `limit` due jobs. Safe with many concurrent workers. */
export async function claimJobs(db: Db, workerId: string, limit: number): Promise<Job[]> {
  const r = await db.query<Job>(
    `UPDATE jobs SET status = 'running', locked_by = $1, locked_at = now(),
                     attempts = attempts + 1, updated_at = now()
     WHERE job_id IN (
       SELECT job_id FROM jobs
       WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, job_id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING job_id, type, payload, attempts, max_attempts, correlation_id, run_at`,
    [workerId, limit],
  );
  return r.rows;
}

export async function completeJob(db: Db, jobId: number): Promise<void> {
  await db.query(
    `UPDATE jobs SET status = 'done', locked_by = NULL, locked_at = NULL, last_error = NULL, updated_at = now()
     WHERE job_id = $1`,
    [jobId],
  );
}

/** Exponential backoff: 30s, 60s, 120s, ... capped at 30 min. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 1800);
}

/**
 * Records a failure. Requeues with backoff, or marks the job dead when out of attempts
 * or when the error is permanent. Returns the resulting status.
 */
export async function failJob(
  db: Db,
  job: Pick<Job, "job_id" | "attempts" | "max_attempts">,
  error: string,
  permanent = false,
): Promise<"queued" | "dead"> {
  const dead = permanent || job.attempts >= job.max_attempts;
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_by = NULL, locked_at = NULL, updated_at = now(),
                     run_at = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $4) ELSE run_at END
     WHERE job_id = $1`,
    [job.job_id, dead ? "dead" : "queued", error.slice(0, 2000), backoffSeconds(job.attempts)],
  );
  return dead ? "dead" : "queued";
}

/** Requeues jobs whose worker died mid-run. Handlers are idempotent, so rerunning is safe. */
export async function reapStaleJobs(db: Db, staleAfterSeconds = 300): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = now(),
                     last_error = 'requeued: worker lock expired'
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
    [staleAfterSeconds],
  );
  return r.rowCount ?? 0;
}

/** Cancels queued jobs matching a dedupe-key prefix, e.g. reminders for a cancelled appointment. */
export async function cancelQueuedJobs(db: Db, dedupeKeyPrefix: string): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET status = 'cancelled', updated_at = now()
     WHERE status = 'queued' AND starts_with(dedupe_key, $1)`,
    [dedupeKeyPrefix],
  );
  return r.rowCount ?? 0;
}
