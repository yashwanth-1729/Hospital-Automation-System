import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { newCorrelationId, newId } from "@/lib/ids";
import { istDateString } from "@/lib/time";
import { markAttendance } from "@/server/workflows/no-show";

export type VisitStatus = "waiting" | "in_consultation" | "completed" | "cancelled";
export type VisitPriority = "normal" | "urgent";

export type VisitErrorCode =
  | "patient_not_found"
  | "doctor_not_found"
  | "appointment_not_found"
  | "appointment_not_active"
  | "appointment_not_today"
  | "visit_not_found"
  | "wrong_state"
  | "doctor_busy";

/** A request the front desk can act on (wrong day, already started), as opposed to a bug. */
export class VisitError extends Error {
  constructor(
    public readonly code: VisitErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Visit {
  visit_id: string;
  patient_id: string;
  appointment_id: string | null;
  department_id: string;
  doctor_id: string;
  visit_date: string;
  token_number: number;
  source: "walk_in" | "appointment";
  status: VisitStatus;
  priority: VisitPriority;
  reason: string | null;
  checked_in_at: Date;
  consult_started_at: Date | null;
  completed_at: Date | null;
  correlation_id: string;
}

const VISIT_COLUMNS = `visit_id, patient_id, appointment_id, department_id, doctor_id, visit_date, token_number, source, status,
  priority, reason, checked_in_at, consult_started_at, completed_at, correlation_id`;

export interface NewVisit {
  patientId: string;
  doctorId: string;
  reason?: string | null;
  priority?: VisitPriority;
  appointmentId?: string | null;
  createdBy?: string | null;
}

/**
 * Puts a patient in a doctor's queue for today and hands out the next token.
 * Idempotent: if they are already waiting for that doctor, that visit comes back unchanged.
 */
async function createVisitIn(c: Db, input: NewVisit): Promise<{ visit: Visit; duplicate: boolean }> {
  const patient = await one(c, `SELECT 1 FROM patients WHERE patient_id = $1`, [input.patientId]);
  if (!patient) throw new VisitError("patient_not_found", "That patient does not exist.");
  const doctor = await one<{ department_id: string }>(c, `SELECT department_id FROM doctors WHERE doctor_id = $1 AND active`, [input.doctorId]);
  if (!doctor) throw new VisitError("doctor_not_found", "Choose a doctor who is currently seeing patients.");

  const today = istDateString();

  const waiting = await one<Visit>(
    c,
    `SELECT ${VISIT_COLUMNS} FROM visits
      WHERE patient_id = $1 AND doctor_id = $2 AND visit_date = $3 AND status IN ('waiting', 'in_consultation')`,
    [input.patientId, input.doctorId, today],
  );
  if (waiting) return { visit: waiting, duplicate: true };

  // Atomic per doctor and day: the row lock serialises concurrent desks.
  const token = await one<{ last_token: number }>(
    c,
    `INSERT INTO visit_tokens (doctor_id, visit_date, last_token) VALUES ($1, $2, 1)
     ON CONFLICT (doctor_id, visit_date) DO UPDATE SET last_token = visit_tokens.last_token + 1
     RETURNING last_token`,
    [input.doctorId, today],
  );

  const visit = await one<Visit>(
    c,
    `INSERT INTO visits (visit_id, patient_id, appointment_id, department_id, doctor_id, visit_date, token_number, source,
                         priority, reason, created_by, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${VISIT_COLUMNS}`,
    [
      newId("VIS"), input.patientId, input.appointmentId ?? null, doctor.department_id, input.doctorId, today,
      token!.last_token, input.appointmentId ? "appointment" : "walk_in", input.priority ?? "normal",
      input.reason?.trim().slice(0, 300) || null, input.createdBy ?? null, newCorrelationId(),
    ],
  );

  await audit(c, {
    workflow: "clinic",
    actor: "staff",
    action: "visit.checked_in",
    recordId: visit!.visit_id,
    correlationId: visit!.correlation_id,
    details: { token: visit!.token_number, doctor_id: input.doctorId, priority: visit!.priority, source: visit!.source },
  });
  return { visit: visit!, duplicate: false };
}

export function createVisit(input: NewVisit): Promise<{ visit: Visit; duplicate: boolean }> {
  return tx((c) => createVisitIn(c, input));
}

/**
 * Check-in for a patient who booked ahead. Takes the next token at the moment they arrive
 * (not when they booked) and marks the appointment attended, which stops any no-show recovery.
 */
export async function checkInAppointment(appointmentId: string, createdBy?: string | null): Promise<{ visit: Visit; duplicate: boolean }> {
  const result = await tx(async (c) => {
    const appt = await one<{
      appointment_id: string;
      patient_id: string;
      doctor_id: string;
      status: string;
      slot_start: Date;
    }>(c, `SELECT appointment_id, patient_id, doctor_id, status, slot_start FROM appointments WHERE appointment_id = $1 FOR UPDATE`, [
      appointmentId,
    ]);
    if (!appt) throw new VisitError("appointment_not_found", "That appointment does not exist.");

    const existing = await one<Visit>(c, `SELECT ${VISIT_COLUMNS} FROM visits WHERE appointment_id = $1`, [appointmentId]);
    if (existing) return { visit: existing, duplicate: true };

    if (appt.status !== "booked") throw new VisitError("appointment_not_active", `This appointment is ${appt.status}.`);
    if (istDateString(appt.slot_start) !== istDateString()) {
      throw new VisitError("appointment_not_today", `This appointment is on ${istDateString(appt.slot_start)}, not today.`);
    }
    return createVisitIn(c, {
      patientId: appt.patient_id,
      doctorId: appt.doctor_id,
      appointmentId,
      createdBy,
      reason: "Booked appointment",
    });
  });

  // After the visit exists, so a failure here leaves a recoverable state; marking is idempotent.
  await markAttendance(appointmentId, "attended", "staff");
  return result;
}

export async function cancelVisit(visitId: string, reason: string): Promise<void> {
  await tx(async (c) => {
    const v = await one<Visit>(c, `SELECT ${VISIT_COLUMNS} FROM visits WHERE visit_id = $1 FOR UPDATE`, [visitId]);
    if (!v) throw new VisitError("visit_not_found", "That visit does not exist.");
    if (v.status !== "waiting") throw new VisitError("wrong_state", `A visit that is ${v.status.replace("_", " ")} cannot be cancelled.`);
    await c.query(
      `UPDATE visits SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() WHERE visit_id = $1`,
      [visitId, reason.trim().slice(0, 300) || "Left before consultation"],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "visit.cancelled", recordId: visitId, correlationId: v.correlation_id });
  });
}

export async function setVisitPriority(visitId: string, priority: VisitPriority): Promise<void> {
  const r = await one<{ visit_id: string }>(
    pool(),
    `UPDATE visits SET priority = $2, updated_at = now() WHERE visit_id = $1 AND status = 'waiting' RETURNING visit_id`,
    [visitId, priority],
  );
  if (!r) throw new VisitError("wrong_state", "Only a waiting patient can be re-prioritised.");
}

/** The doctor calls the patient in. One at a time per doctor. */
export async function startConsultation(visitId: string): Promise<Visit> {
  return tx(async (c) => {
    const v = await one<Visit>(c, `SELECT ${VISIT_COLUMNS} FROM visits WHERE visit_id = $1 FOR UPDATE`, [visitId]);
    if (!v) throw new VisitError("visit_not_found", "That visit does not exist.");
    if (v.status === "in_consultation") return v; // idempotent: the page was reloaded
    if (v.status !== "waiting") throw new VisitError("wrong_state", `This visit is ${v.status}.`);

    const busy = await one(
      c,
      `SELECT 1 FROM visits WHERE doctor_id = $1 AND visit_date = $2 AND status = 'in_consultation' AND visit_id <> $3`,
      [v.doctor_id, v.visit_date, visitId],
    );
    if (busy) throw new VisitError("doctor_busy", "Finish the current consultation before calling the next patient.");

    const started = await one<Visit>(
      c,
      `UPDATE visits SET status = 'in_consultation', consult_started_at = now(), updated_at = now()
        WHERE visit_id = $1 RETURNING ${VISIT_COLUMNS}`,
      [visitId],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "consultation.started", recordId: visitId, correlationId: v.correlation_id });
    return started!;
  });
}

export async function completeVisit(c: Db, visitId: string): Promise<void> {
  const v = await one<Visit>(c, `SELECT ${VISIT_COLUMNS} FROM visits WHERE visit_id = $1 FOR UPDATE`, [visitId]);
  if (!v) throw new VisitError("visit_not_found", "That visit does not exist.");
  if (v.status === "completed") return;
  if (v.status !== "in_consultation") throw new VisitError("wrong_state", `This visit is ${v.status}.`);
  await c.query(`UPDATE visits SET status = 'completed', completed_at = now(), updated_at = now() WHERE visit_id = $1`, [visitId]);
  await audit(c, { workflow: "clinic", actor: "staff", action: "consultation.completed", recordId: visitId, correlationId: v.correlation_id });
}

export interface QueueRow {
  visit_id: string;
  token_number: number;
  status: VisitStatus;
  priority: VisitPriority;
  source: "walk_in" | "appointment";
  reason: string | null;
  checked_in_at: Date;
  consult_started_at: Date | null;
  completed_at: Date | null;
  wait_minutes: number;
  patient_id: string;
  patient_name: string;
  uhid: string;
  gender: string | null;
  date_of_birth: string | null;
  dob_estimated: boolean;
  allergies: string | null;
  doctor_id: string;
  doctor_name: string;
  department: string;
}

/**
 * Everyone seen or waiting on a day, in the order the doctor will take them: urgent first,
 * then by token. Finished and cancelled visits sort to the bottom.
 */
export async function listQueue(db: Db, opts: { date?: string; doctorId?: string } = {}): Promise<QueueRow[]> {
  return many<QueueRow>(
    db,
    `SELECT v.visit_id, v.token_number, v.status, v.priority, v.source, v.reason, v.checked_in_at, v.consult_started_at,
            v.completed_at,
            GREATEST(0, round(EXTRACT(EPOCH FROM (COALESCE(v.consult_started_at, v.cancelled_at, now()) - v.checked_in_at)) / 60))::int AS wait_minutes,
            p.patient_id, p.full_name AS patient_name, p.uhid, p.gender, p.date_of_birth, p.dob_estimated, p.allergies,
            d.doctor_id, d.full_name AS doctor_name, dep.name AS department
       FROM visits v
       JOIN patients p ON p.patient_id = v.patient_id
       JOIN doctors d ON d.doctor_id = v.doctor_id
       JOIN departments dep ON dep.department_id = v.department_id
      WHERE v.visit_date = $1 AND ($2::text IS NULL OR v.doctor_id = $2)
      ORDER BY CASE v.status WHEN 'in_consultation' THEN 0 WHEN 'waiting' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
               (v.priority = 'urgent') DESC, v.token_number`,
    [opts.date ?? istDateString(), opts.doctorId ?? null],
  );
}

export interface QueueSummary {
  waiting: number;
  in_consultation: number;
  completed: number;
  cancelled: number;
  longest_wait_minutes: number;
}

export async function queueSummary(db: Db, date: string = istDateString()): Promise<QueueSummary> {
  const r = await one<QueueSummary>(
    db,
    `SELECT count(*) FILTER (WHERE status = 'waiting')::int          AS waiting,
            count(*) FILTER (WHERE status = 'in_consultation')::int AS in_consultation,
            count(*) FILTER (WHERE status = 'completed')::int       AS completed,
            count(*) FILTER (WHERE status = 'cancelled')::int       AS cancelled,
            COALESCE(max(round(EXTRACT(EPOCH FROM (now() - checked_in_at)) / 60)) FILTER (WHERE status = 'waiting'), 0)::int
              AS longest_wait_minutes
       FROM visits WHERE visit_date = $1`,
    [date],
  );
  return r!;
}

/** Today's booked appointments that have not arrived yet: the front desk's "expected" list. */
export async function listExpectedToday(db: Db): Promise<
  {
    appointment_id: string;
    slot_start: Date;
    patient_name: string;
    uhid: string;
    doctor_name: string;
    department: string;
    visit_id: string | null;
    visit_status: VisitStatus | null;
    token_number: number | null;
  }[]
> {
  return many(
    db,
    `SELECT a.appointment_id, a.slot_start, p.full_name AS patient_name, p.uhid, d.full_name AS doctor_name,
            dep.name AS department, v.visit_id, v.status AS visit_status, v.token_number
       FROM appointments a
       JOIN patients p ON p.patient_id = a.patient_id
       JOIN doctors d ON d.doctor_id = a.doctor_id
       JOIN departments dep ON dep.department_id = a.department_id
       LEFT JOIN visits v ON v.appointment_id = a.appointment_id
      WHERE a.status = 'booked'
        AND (a.slot_start AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      ORDER BY a.slot_start`,
    [istDateString()],
  );
}
