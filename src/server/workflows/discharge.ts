import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { many, one, pool, tx } from "@/lib/db";
import { env } from "@/lib/env";
import { raiseException } from "@/lib/exceptions";
import { CORRELATION_ID_PATTERN, newCorrelationId, newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { normalizeIndianPhone } from "@/lib/phone";
import { formatDateOnly, istAt, istDateString, isValidDateString } from "@/lib/time";
import { sendTemplateMessage } from "@/server/messaging/send";
import { resolveDepartment } from "@/server/ai/rules";
import { JOB } from "./job-types";

/**
 * A discharge event, as reported by the hospital (HMS webhook or staff form).
 *
 * The follow-up date must come from the hospital and carry the name of the person who
 * approved it. Nothing here is inferred: no clinical instructions are accepted or stored.
 */
export const DischargePayloadSchema = z.object({
  full_name: z.string().trim().min(2, "Name is too short").max(120),
  phone: z.string().trim().min(6, "Enter a valid 10-digit Indian mobile number").max(20),
  encounter_id: z.string().trim().max(60).optional().nullable(),
  department: z.string().trim().max(60).optional().nullable(),
  discharged_at: z.preprocess((v) => (v === "" ? undefined : v), z.iso.datetime({ offset: true }).optional()),
  approved_followup_date: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().refine(isValidDateString, "approved_followup_date must be YYYY-MM-DD").optional().nullable(),
  ),
  approved_followup_window: z.string().trim().max(80).optional().nullable(),
  approved_by: z.string().trim().max(120).optional().nullable(),
  source: z.string().trim().min(1).max(60).default("hms"),
  consent: z.boolean().optional(),
  correlation_id: z.string().regex(CORRELATION_ID_PATTERN).optional(),
});
export type DischargePayload = z.input<typeof DischargePayloadSchema>;

export type DischargeResult =
  | { ok: true; dischargeId: string; correlationId: string; duplicate: boolean }
  | { ok: false; errors: Record<string, string> };

/** Records the discharge and queues the follow-up work. Idempotent per encounter/patient/day. */
export async function recordDischarge(input: unknown): Promise<DischargeResult> {
  const parsed = DischargePayloadSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[issue.path.join(".") || "_"] ??= issue.message;
    return { ok: false, errors };
  }
  const p = parsed.data;
  const phone = normalizeIndianPhone(p.phone);
  if (!phone) return { ok: false, errors: { phone: "Enter a valid 10-digit Indian mobile number" } };

  const dischargedAt = p.discharged_at ? new Date(p.discharged_at) : new Date();
  if (p.approved_followup_date && p.approved_followup_date < istDateString(dischargedAt)) {
    return { ok: false, errors: { approved_followup_date: "Follow-up date cannot be before the discharge date" } };
  }
  // A date without a named approver is not an approved date.
  if (p.approved_followup_date && !p.approved_by?.trim()) {
    return { ok: false, errors: { approved_by: "Record who approved this follow-up date" } };
  }

  // Map the reported department name to a configured department id. An unknown name is an
  // integration mismatch, not something to guess at.
  let departmentId: string | null = null;
  if (p.department) {
    const departments = await many<{ id: string; name: string }>(
      pool(),
      `SELECT department_id AS id, name FROM departments WHERE active`,
    );
    departmentId = resolveDepartment(p.department, departments);
    if (!departmentId) return { ok: false, errors: { department: `Unknown department "${p.department}"` } };
  }

  const key = p.correlation_id
    ? `cid:${p.correlation_id}`
    : `h:${createHash("sha256").update([phone, p.encounter_id ?? "", istDateString(dischargedAt)].join("|")).digest("hex").slice(0, 32)}`;
  const consent = p.consent === undefined ? null : p.consent ? "granted" : "denied";

  return tx(async (c) => {
    const existing = await one<{ discharge_id: string; correlation_id: string }>(
      c,
      `SELECT discharge_id, correlation_id FROM discharges WHERE idempotency_key = $1`,
      [key],
    );
    if (existing) {
      return { ok: true as const, dischargeId: existing.discharge_id, correlationId: existing.correlation_id, duplicate: true };
    }

    const patient = (await one<{ patient_id: string }>(
      c,
      `INSERT INTO patients (patient_id, full_name, phone, source, consent_status)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'unknown'))
       ON CONFLICT (phone) DO UPDATE SET consent_status = COALESCE($5, patients.consent_status), updated_at = now()
       RETURNING patient_id`,
      [newId("PAT"), p.full_name, phone, p.source, consent],
    ))!;

    const dischargeId = newId("DIS");
    const correlationId = p.correlation_id ?? newCorrelationId();
    await c.query(
      `INSERT INTO discharges (discharge_id, patient_id, encounter_id, department_id, discharged_at,
                               approved_followup_date, approved_followup_window, approved_by, source,
                               idempotency_key, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [dischargeId, patient.patient_id, p.encounter_id ?? null, departmentId, dischargedAt,
       p.approved_followup_date ?? null, p.approved_followup_window ?? null, p.approved_by ?? null, p.source, key, correlationId],
    );
    await audit(c, {
      workflow: "discharge",
      actor: p.source === "staff" ? "staff" : "integration",
      action: "discharge.recorded",
      recordId: dischargeId,
      correlationId,
      details: {
        source: p.source,
        has_approved_followup: !!p.approved_followup_date,
        approved_by: p.approved_by ?? null,
      },
    });
    await enqueue(c, {
      type: JOB.dischargeProcess,
      payload: { discharge_id: dischargeId },
      dedupeKey: `discharge.process:${dischargeId}`,
      correlationId,
    });
    return { ok: true as const, dischargeId, correlationId, duplicate: false };
  });
}

interface DischargeRow {
  discharge_id: string;
  patient_id: string;
  patient_name: string;
  department_name: string | null;
  discharged_at: Date;
  approved_followup_date: string | null;
  approved_followup_window: string | null;
  approved_by: string | null;
  status: string;
  correlation_id: string;
}

async function loadDischarge(dischargeId: string): Promise<DischargeRow | undefined> {
  return one<DischargeRow>(
    pool(),
    `SELECT d.discharge_id, d.patient_id, p.full_name AS patient_name, dep.name AS department_name, d.discharged_at,
            d.approved_followup_date, d.approved_followup_window, d.approved_by, d.status, d.correlation_id
     FROM discharges d
     JOIN patients p USING (patient_id)
     LEFT JOIN departments dep ON dep.department_id = d.department_id
     WHERE d.discharge_id = $1`,
    [dischargeId],
  );
}

function followUpLabel(d: DischargeRow): string {
  const date = formatDateOnly(d.approved_followup_date!);
  return d.approved_followup_window ? `${date} (${d.approved_followup_window})` : date;
}

/**
 * Worker job: create the follow-up task, relay the approved date to the patient,
 * schedule the day-before reminder and the feedback request.
 */
export async function processDischarge(dischargeId: string): Promise<void> {
  const e = env();
  const d = await loadDischarge(dischargeId);
  if (!d) throw new Error(`Discharge ${dischargeId} not found`);
  if (d.status !== "new") return;

  // Feedback is administrative, so it is requested whether or not a follow-up was approved.
  const feedbackAt = new Date(d.discharged_at.getTime() + e.FEEDBACK_DELAY_HOURS * 3600_000);

  if (!d.approved_followup_date) {
    await tx(async (c) => {
      const updated = await c.query(
        `UPDATE discharges SET status = 'needs_review', updated_at = now() WHERE discharge_id = $1 AND status = 'new'`,
        [dischargeId],
      );
      if (!updated.rowCount) return;
      await raiseException(c, {
        workflow: "discharge",
        errorType: "DISCHARGE_FOLLOWUP_DATE_MISSING",
        severity: "medium",
        summary: `No approved follow-up date for ${d.patient_name}'s discharge. A clinician must confirm the date before the patient is contacted.`,
        recordId: dischargeId,
        correlationId: d.correlation_id,
        owner: "department_owner",
        details: { department: d.department_name },
        dedupeKey: `discharge-no-date:${dischargeId}`,
      });
      await audit(c, {
        workflow: "discharge",
        actor: "system",
        action: "discharge.awaiting_approved_date",
        recordId: dischargeId,
        correlationId: d.correlation_id,
      });
      await enqueue(c, {
        type: JOB.feedbackRequest,
        payload: { discharge_id: dischargeId },
        runAt: feedbackAt,
        dedupeKey: `feedback.request:${dischargeId}`,
        correlationId: d.correlation_id,
      });
    });
    return;
  }

  const reminderAt = istAt(d.approved_followup_date, e.FOLLOWUP_REMINDER_HOUR);
  const dayBefore = new Date(reminderAt.getTime() - 24 * 3600_000);

  await tx(async (c) => {
    const updated = await c.query(
      `UPDATE discharges SET status = 'scheduled', updated_at = now() WHERE discharge_id = $1 AND status = 'new'`,
      [dischargeId],
    );
    if (!updated.rowCount) return;

    await c.query(
      `INSERT INTO follow_ups (followup_id, patient_id, discharge_id, category, approved_date, approved_window, owner,
                               status, attempt_count, next_action_at, notes, dedupe_key, correlation_id)
       VALUES ($1, $2, $3, 'post_discharge', $4, $5, 'department_owner', 'open', 0, $6, $7, $8, $9)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        newId("FUP"),
        d.patient_id,
        dischargeId,
        d.approved_followup_date,
        d.approved_followup_window ?? null,
        dayBefore,
        `Follow-up approved by ${d.approved_by} for ${followUpLabel(d)}.`,
        `discharge:${dischargeId}`,
        d.correlation_id,
      ],
    );
    await enqueue(c, {
      type: JOB.dischargeReminder,
      payload: { discharge_id: dischargeId, followup_date: d.approved_followup_date },
      runAt: dayBefore,
      dedupeKey: `discharge.reminder:${dischargeId}:${d.approved_followup_date}`,
      correlationId: d.correlation_id,
    });
    await enqueue(c, {
      type: JOB.feedbackRequest,
      payload: { discharge_id: dischargeId },
      runAt: feedbackAt,
      dedupeKey: `feedback.request:${dischargeId}`,
      correlationId: d.correlation_id,
    });
    await audit(c, {
      workflow: "discharge",
      actor: "system",
      action: "discharge.followup_scheduled",
      recordId: dischargeId,
      correlationId: d.correlation_id,
      details: { approved_followup_date: d.approved_followup_date, approved_by: d.approved_by, reminder_at: dayBefore },
    });
  });

  await sendTemplateMessage({
    dedupeKey: `msg:${dischargeId}:DISCHARGE_FOLLOWUP_01`,
    patientId: d.patient_id,
    template: "DISCHARGE_FOLLOWUP_01",
    workflow: "discharge",
    correlationId: d.correlation_id,
    vars: {
      patient_name: d.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      followup_date: followUpLabel(d),
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
}

/** Day-before reminder for the approved follow-up. Skipped if staff closed or changed it. */
export async function sendDischargeReminder(dischargeId: string, followupDate: string): Promise<void> {
  const e = env();
  const d = await loadDischarge(dischargeId);
  if (!d) throw new Error(`Discharge ${dischargeId} not found`);

  const skip = (reason: string) =>
    audit(pool(), {
      workflow: "discharge",
      actor: "system",
      action: "discharge.reminder_skipped",
      recordId: dischargeId,
      correlationId: d.correlation_id,
      details: { reason },
    });

  if (d.status === "closed") return skip("discharge closed");
  if (d.approved_followup_date !== followupDate) return skip("follow-up date changed");
  const task = await one<{ status: string }>(pool(), `SELECT status FROM follow_ups WHERE dedupe_key = $1`, [`discharge:${dischargeId}`]);
  if (task && task.status !== "open") return skip(`follow-up task is ${task.status}`);

  await sendTemplateMessage({
    dedupeKey: `msg:${dischargeId}:FOLLOWUP_REMINDER_01:${followupDate}`,
    patientId: d.patient_id,
    template: "FOLLOWUP_REMINDER_01",
    workflow: "discharge",
    correlationId: d.correlation_id,
    vars: {
      patient_name: d.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      followup_date: followUpLabel(d),
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
}

/** Sends the one-time feedback link. */
export async function requestFeedback(dischargeId: string): Promise<void> {
  const e = env();
  const d = await loadDischarge(dischargeId);
  if (!d) throw new Error(`Discharge ${dischargeId} not found`);

  const existing = await one<{ token: string }>(pool(), `SELECT token FROM feedback_requests WHERE discharge_id = $1`, [dischargeId]);
  const token = existing?.token ?? randomBytes(16).toString("base64url");
  if (!existing) {
    await pool().query(
      `INSERT INTO feedback_requests (token, patient_id, discharge_id, correlation_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
      [token, d.patient_id, dischargeId, d.correlation_id, e.FEEDBACK_LINK_VALID_DAYS],
    );
  }

  await sendTemplateMessage({
    dedupeKey: `msg:${dischargeId}:FEEDBACK_REQUEST_01`,
    patientId: d.patient_id,
    template: "FEEDBACK_REQUEST_01",
    workflow: "discharge",
    correlationId: d.correlation_id,
    vars: {
      patient_name: d.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      feedback_link: `${e.PUBLIC_BASE_URL.replace(/\/$/, "")}/r/${token}`,
    },
  });
}

export interface FeedbackTarget {
  token: string;
  patient_name: string;
  hospital_department: string | null;
  responded_at: Date | null;
  expired: boolean;
}

export async function getFeedbackRequest(token: string): Promise<FeedbackTarget | undefined> {
  return one<FeedbackTarget>(
    pool(),
    `SELECT fr.token, p.full_name AS patient_name, dep.name AS hospital_department, fr.responded_at,
            (fr.expires_at < now()) AS expired
     FROM feedback_requests fr
     JOIN patients p USING (patient_id)
     LEFT JOIN discharges d ON d.discharge_id = fr.discharge_id
     LEFT JOIN departments dep ON dep.department_id = d.department_id
     WHERE fr.token = $1`,
    [token],
  );
}

/** Ratings at or below this open a service-recovery task (blueprint section R, step 9). */
export const SERVICE_RECOVERY_THRESHOLD = 3;

export type FeedbackOutcome = "recorded" | "already_submitted" | "expired" | "unknown_token";

/** Stores a patient rating and routes an unhappy one to service recovery. */
export async function submitFeedback(token: string, rating: number, comment: string | null): Promise<FeedbackOutcome> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Rating must be 1-5");

  return tx(async (c) => {
    const req = await one<{
      patient_id: string;
      discharge_id: string | null;
      correlation_id: string | null;
      responded_at: Date | null;
      expired: boolean;
      patient_name: string;
    }>(
      c,
      `SELECT fr.patient_id, fr.discharge_id, fr.correlation_id, fr.responded_at, (fr.expires_at < now()) AS expired,
              p.full_name AS patient_name
       FROM feedback_requests fr JOIN patients p USING (patient_id)
       WHERE fr.token = $1 FOR UPDATE OF fr`,
      [token],
    );
    if (!req) return "unknown_token";
    if (req.responded_at) return "already_submitted";
    if (req.expired) return "expired";

    const trimmed = comment?.trim().slice(0, 1000) || null;
    await c.query(
      `INSERT INTO feedback (feedback_id, token, patient_id, discharge_id, rating, comment, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId("FBK"), token, req.patient_id, req.discharge_id, rating, trimmed, req.correlation_id],
    );
    await c.query(`UPDATE feedback_requests SET responded_at = now() WHERE token = $1`, [token]);
    await audit(c, {
      workflow: "discharge",
      actor: "patient",
      action: "feedback.received",
      recordId: req.discharge_id ?? token,
      correlationId: req.correlation_id,
      details: { rating, has_comment: !!trimmed },
    });

    if (rating <= SERVICE_RECOVERY_THRESHOLD) {
      await raiseException(c, {
        workflow: "discharge",
        errorType: "NEGATIVE_FEEDBACK",
        severity: rating <= 2 ? "high" : "medium",
        summary: `${req.patient_name} rated their experience ${rating}/5. Service recovery: call the patient.`,
        recordId: req.discharge_id ?? token,
        correlationId: req.correlation_id,
        owner: "service_recovery",
        details: { rating, comment: trimmed },
        dedupeKey: `negative-feedback:${token}`,
      });
      await c.query(
        `INSERT INTO follow_ups (followup_id, patient_id, discharge_id, category, owner, status, attempt_count,
                                 next_action_at, notes, dedupe_key, correlation_id)
         VALUES ($1, $2, $3, 'service_recovery', 'service_recovery', 'open', 0, now(), $4, $5, $6)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          newId("FUP"),
          req.patient_id,
          req.discharge_id,
          `Rated ${rating}/5.${trimmed ? ` Patient said: "${trimmed}"` : ""}`,
          `service-recovery:${token}`,
          req.correlation_id,
        ],
      );
      await audit(c, {
        workflow: "discharge",
        actor: "system",
        action: "feedback.service_recovery_opened",
        recordId: req.discharge_id ?? token,
        correlationId: req.correlation_id,
        details: { rating },
      });
    }
    return "recorded";
  });
}
