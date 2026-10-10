import { currentActorId } from "./actor";
import type { Db } from "./db";
import { WORKFLOWS, type WorkflowKey } from "./workflows";

export type ActorType = "system" | "ai" | "staff" | "patient" | "integration";

export interface AuditEvent {
  workflow: WorkflowKey;
  actor: ActorType;
  action: string;
  recordId?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
  /** Staff member responsible. Defaults to whoever is signed in for this request. */
  actorId?: string | null;
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  const wf = WORKFLOWS[e.workflow];
  const actorId = e.actor === "staff" ? (e.actorId ?? currentActorId()) : null;
  await db.query(
    `INSERT INTO audit_log (workflow_name, workflow_version, actor_type, action, record_id, details, correlation_id, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [wf.name, wf.version, e.actor, e.action, e.recordId ?? null, e.details ?? null, e.correlationId ?? null, actorId],
  );
}
