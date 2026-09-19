import type { Db } from "./db";
import { newId } from "./ids";
import { WORKFLOWS, type WorkflowKey } from "./workflows";

export type Severity = "low" | "medium" | "high";

const RESPONSE_WINDOW_MINUTES: Record<Severity, number> = { high: 30, medium: 240, low: 1440 };

export interface NewException {
  workflow: WorkflowKey;
  errorType: string;
  severity: Severity;
  summary: string;
  recordId?: string | null;
  owner?: string;
  correlationId?: string | null;
  details?: Record<string, unknown>;
  /** Prevents the same problem from opening duplicate exceptions (e.g. on job retry). */
  dedupeKey?: string;
}

/** Opens an exception for staff. Returns the exception id (existing one if deduped). */
export async function raiseException(db: Db, e: NewException): Promise<string> {
  const id = newId("EXC");
  const r = await db.query<{ exception_id: string }>(
    `INSERT INTO exceptions (exception_id, workflow_name, record_id, error_type, severity, owner, due_at,
                             summary, details, dedupe_key, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7), $8, $9, $10, $11)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING exception_id`,
    [
      id,
      WORKFLOWS[e.workflow].name,
      e.recordId ?? null,
      e.errorType,
      e.severity,
      e.owner ?? "front_desk",
      RESPONSE_WINDOW_MINUTES[e.severity],
      e.summary,
      e.details ?? null,
      e.dedupeKey ?? null,
      e.correlationId ?? null,
    ],
  );
  if (r.rows[0]) return r.rows[0].exception_id;
  const existing = await db.query<{ exception_id: string }>(
    `SELECT exception_id FROM exceptions WHERE dedupe_key = $1`,
    [e.dedupeKey],
  );
  return existing.rows[0]!.exception_id;
}

export async function resolveException(db: Db, exceptionId: string, note: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE exceptions SET status = 'resolved', resolution_note = $2, resolved_at = now()
     WHERE exception_id = $1 AND status = 'open'`,
    [exceptionId, note],
  );
  return (r.rowCount ?? 0) > 0;
}
