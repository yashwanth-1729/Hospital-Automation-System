import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { raiseException } from "@/lib/exceptions";
import { newCorrelationId, newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { sendTemplateMessage } from "@/server/messaging/send";
import { JOB } from "@/server/workflows/job-types";

/**
 * Lab report follow-up. When a report is ready, from the hospital's lab system or marked by
 * staff, the patient is told on WhatsApp to come and go through it with the doctor, and the
 * doctor is chased if nobody has reviewed it. Abnormal results go to the doctor at once.
 */

/** A ready report nobody has reviewed after this long becomes a task for the doctor. */
export const REVIEW_WITHIN_HOURS = 24;
/** A test ordered this long ago with no result is listed as waiting too long. */
export const RESULT_EXPECTED_DAYS = 3;

export class LabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabError";
  }
}

export interface LabInput {
  patientId: string;
  testName: string;
  category?: string;
  doctorName?: string | null;
  orderedAt?: Date | null;
  readyAt?: Date | null;
  flag?: "normal" | "abnormal" | null;
  externalId?: string | null;
  source?: "clevo" | "hms";
}

/**
 * Records a test, or its result if it already exists (same external id from the HMS). A result
 * queues the patient's WhatsApp; an abnormal one also raises an urgent task for the doctor.
 */
export async function recordLab(input: LabInput): Promise<{ diagnosticId: string; ready: boolean }> {
  const testName = input.testName.trim().slice(0, 120);
  if (testName.length < 2) throw new LabError("Say which test this is.");
  return tx(async (c) => {
    const existing = input.externalId
      ? await one<{ diagnostic_id: string; report_ready_at: Date | null }>(
          c,
          `SELECT diagnostic_id, report_ready_at FROM diagnostic_tasks WHERE external_id = $1 FOR UPDATE`,
          [input.externalId],
        )
      : null;
    const id = existing?.diagnostic_id ?? newId("LAB");
    const correlation = newCorrelationId();
    if (existing) {
      await c.query(
        `UPDATE diagnostic_tasks SET report_ready_at = COALESCE(report_ready_at, $2), result_flag = COALESCE($3, result_flag),
                completed_at = COALESCE(completed_at, $2)
          WHERE diagnostic_id = $1`,
        [id, input.readyAt ?? null, input.flag ?? null],
      );
    } else {
      await c.query(
        `INSERT INTO diagnostic_tasks (diagnostic_id, patient_id, test_category, test_name, doctor_name, ordered_at, completed_at,
                                       report_ready_at, result_flag, source, external_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $7, $8, $9, $10, $11)`,
        [id, input.patientId, input.category ?? "lab", testName, input.doctorName ?? null, input.orderedAt ?? null,
          input.readyAt ?? null, input.flag ?? null, input.source ?? "clevo", input.externalId ?? null, correlation],
      );
    }
    const becameReady = !!input.readyAt && !existing?.report_ready_at;
    if (becameReady) {
      await enqueue(c, { type: JOB.labNotify, payload: { diagnostic_id: id }, dedupeKey: `lab-notify:${id}`, correlationId: correlation });
      if (input.flag === "abnormal") {
        const p = await one<{ full_name: string }>(c, `SELECT full_name FROM patients WHERE patient_id = $1`, [input.patientId]);
        await raiseException(c, {
          workflow: "clinic",
          errorType: "LAB_ABNORMAL",
          severity: "high",
          summary: `Abnormal ${testName} result for ${p?.full_name ?? "a patient"}${input.doctorName ? ` (${input.doctorName})` : ""}. Please review today.`,
          recordId: id,
          correlationId: correlation,
          owner: "doctor",
          dedupeKey: `lab-abnormal:${id}`,
        });
      }
    }
    await audit(c, {
      workflow: "clinic",
      actor: input.source === "hms" ? "system" : "staff",
      action: becameReady ? "lab.report_ready" : "lab.recorded",
      recordId: id,
      details: { test: testName, flag: input.flag ?? null, source: input.source ?? "clevo" },
    });
    return { diagnosticId: id, ready: !!(input.readyAt ?? existing?.report_ready_at) };
  });
}

/** Staff mark a waiting test's report as ready. */
export async function markReportReady(actorId: string, diagnosticId: string, flag: "normal" | "abnormal"): Promise<void> {
  const row = await one<{ patient_id: string; test_name: string | null; test_category: string; report_ready_at: Date | null; external_id: string | null }>(
    pool(),
    `SELECT patient_id, test_name, test_category, report_ready_at, external_id FROM diagnostic_tasks WHERE diagnostic_id = $1`,
    [diagnosticId],
  );
  if (!row) throw new LabError("That test does not exist.");
  if (row.report_ready_at) throw new LabError("This report is already marked ready.");
  // Give it a stable external id so recordLab updates this row rather than adding one.
  const externalId = row.external_id ?? `clevo:${diagnosticId}`;
  if (!row.external_id) await pool().query(`UPDATE diagnostic_tasks SET external_id = $2 WHERE diagnostic_id = $1`, [diagnosticId, externalId]);
  await recordLab({ patientId: row.patient_id, testName: row.test_name ?? row.test_category, readyAt: new Date(), flag, externalId });
  await audit(pool(), { workflow: "clinic", actor: "staff", action: "lab.marked_ready", recordId: diagnosticId, actorId });
}

/** The patient's WhatsApp. Idempotent through the message's dedupe key. */
export async function notifyLabReady(diagnosticId: string): Promise<void> {
  const row = await one<{ patient_id: string; patient_name: string; test_name: string | null; test_category: string; correlation_id: string | null }>(
    pool(),
    `SELECT d.patient_id, p.full_name AS patient_name, d.test_name, d.test_category, d.correlation_id
       FROM diagnostic_tasks d JOIN patients p ON p.patient_id = d.patient_id WHERE d.diagnostic_id = $1`,
    [diagnosticId],
  );
  if (!row) throw new LabError(`Lab ${diagnosticId} not found`);
  const e = env();
  const outcome = await sendTemplateMessage({
    dedupeKey: `msg:lab:${diagnosticId}`,
    patientId: row.patient_id,
    template: "LAB_REPORT_READY_01",
    workflow: "clinic",
    correlationId: row.correlation_id,
    vars: { patient_name: row.patient_name, test_name: row.test_name ?? row.test_category, hospital_name: e.HOSPITAL_NAME, hospital_contact: e.HOSPITAL_CONTACT },
  });
  if (outcome.status === "sent" || outcome.status === "duplicate" || outcome.status === "ambiguous") {
    await pool().query(
      `UPDATE diagnostic_tasks SET notified_at = COALESCE(notified_at, now()), notification_status = 'sent' WHERE diagnostic_id = $1`,
      [diagnosticId],
    );
  } else {
    await pool().query(`UPDATE diagnostic_tasks SET notification_status = 'skipped' WHERE diagnostic_id = $1`, [diagnosticId]);
  }
}

export async function markReviewed(actorId: string, diagnosticId: string): Promise<void> {
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE diagnostic_tasks SET review_status = 'reviewed', reviewed_at = now(), reviewed_by = $2
        WHERE diagnostic_id = $1 AND report_ready_at IS NOT NULL AND review_status <> 'reviewed'`,
      [diagnosticId, actorId],
    );
    if (!r.rowCount) throw new LabError("This report is not waiting for review.");
    // The doctor has seen it: the chasing tasks are done.
    await c.query(
      `UPDATE exceptions SET status = 'resolved', resolved_at = now(), resolution_note = 'Report reviewed'
        WHERE record_id = $1 AND status = 'open' AND error_type IN ('LAB_ABNORMAL', 'LAB_REVIEW_OVERDUE')`,
      [diagnosticId],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "lab.reviewed", recordId: diagnosticId, actorId });
  });
}

/** The worker's pass: ready reports nobody has reviewed for a day become a task for the doctor. */
export async function sweepLabs(): Promise<number> {
  const rows = await many<{ diagnostic_id: string; patient_name: string; test: string; doctor_name: string | null; correlation_id: string | null }>(
    pool(),
    `SELECT d.diagnostic_id, p.full_name AS patient_name, COALESCE(d.test_name, d.test_category) AS test, d.doctor_name, d.correlation_id
       FROM diagnostic_tasks d JOIN patients p ON p.patient_id = d.patient_id
      WHERE d.report_ready_at IS NOT NULL AND d.review_status <> 'reviewed'
        AND d.report_ready_at < now() - make_interval(hours => $1)
        AND NOT EXISTS (SELECT 1 FROM exceptions x WHERE x.dedupe_key = 'lab-review:' || d.diagnostic_id)`,
    [REVIEW_WITHIN_HOURS],
  );
  for (const r of rows) {
    await raiseException(pool(), {
      workflow: "clinic",
      errorType: "LAB_REVIEW_OVERDUE",
      severity: "medium",
      summary: `${r.patient_name}'s ${r.test} report has been ready for over ${REVIEW_WITHIN_HOURS} hours without review${r.doctor_name ? ` (${r.doctor_name})` : ""}.`,
      recordId: r.diagnostic_id,
      correlationId: r.correlation_id,
      owner: "doctor",
      dedupeKey: `lab-review:${r.diagnostic_id}`,
    });
  }
  return rows.length;
}

// --- views ---------------------------------------------------------------------------------------

export type LabView = "review" | "waiting" | "done";

export interface LabRow {
  diagnostic_id: string;
  patient_id: string;
  patient_name: string;
  uhid: string;
  test: string;
  doctor_name: string | null;
  ordered_at: Date | null;
  report_ready_at: Date | null;
  result_flag: "normal" | "abnormal" | null;
  notified_at: Date | null;
  notification_status: string;
  reviewed_at: Date | null;
  reviewed_by_name: string | null;
  source: string;
  hours_waiting: number | null;
}

export async function listLabs(db: Db, view: LabView, limit = 200): Promise<LabRow[]> {
  const where =
    view === "review"
      ? `d.report_ready_at IS NOT NULL AND d.review_status <> 'reviewed'`
      : view === "waiting"
        ? `d.report_ready_at IS NULL`
        : `d.review_status = 'reviewed'`;
  const order =
    view === "review"
      ? `(d.result_flag = 'abnormal') DESC, d.report_ready_at`
      : view === "waiting"
        ? `d.ordered_at`
        : `d.reviewed_at DESC`;
  return many<LabRow>(
    db,
    `SELECT d.diagnostic_id, d.patient_id, p.full_name AS patient_name, p.uhid, COALESCE(d.test_name, d.test_category) AS test,
            d.doctor_name, d.ordered_at, d.report_ready_at, d.result_flag, d.notified_at, d.notification_status, d.reviewed_at,
            u.full_name AS reviewed_by_name, d.source,
            round(extract(epoch FROM now() - COALESCE(d.report_ready_at, d.ordered_at)) / 3600)::int AS hours_waiting
       FROM diagnostic_tasks d JOIN patients p ON p.patient_id = d.patient_id
       LEFT JOIN staff_users u ON u.user_id = d.reviewed_by
      WHERE ${where}
      ORDER BY ${order}
      LIMIT $1`,
    [limit],
  );
}

export interface LabStats {
  awaiting_review: number;
  abnormal_open: number;
  overdue_review: number;
  waiting_results: number;
  patients_told_7d: number;
  reviewed_7d: number;
}

export async function labStats(db: Db): Promise<LabStats> {
  const r = await one<LabStats>(
    db,
    `SELECT count(*) FILTER (WHERE report_ready_at IS NOT NULL AND review_status <> 'reviewed')::int AS awaiting_review,
            count(*) FILTER (WHERE report_ready_at IS NOT NULL AND review_status <> 'reviewed' AND result_flag = 'abnormal')::int AS abnormal_open,
            count(*) FILTER (WHERE report_ready_at < now() - make_interval(hours => $1) AND review_status <> 'reviewed')::int AS overdue_review,
            count(*) FILTER (WHERE report_ready_at IS NULL)::int AS waiting_results,
            count(*) FILTER (WHERE notified_at > now() - interval '7 days')::int AS patients_told_7d,
            count(*) FILTER (WHERE reviewed_at > now() - interval '7 days')::int AS reviewed_7d
       FROM diagnostic_tasks`,
    [REVIEW_WITHIN_HOURS],
  );
  return r!;
}

export { pool as labPool };
