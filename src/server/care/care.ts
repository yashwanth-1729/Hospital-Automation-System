import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { raiseException } from "@/lib/exceptions";
import { newCorrelationId, newId } from "@/lib/ids";
import { addDays, formatDateOnly, istDateString } from "@/lib/time";
import { sendTemplateMessage } from "@/server/messaging/send";

/**
 * Chronic care recall. A patient diagnosed with a long-term condition is enrolled on a care
 * plan with a repeat-visit interval; Clevo reminds them on WhatsApp shortly before the visit is
 * due, once more if they do not come, and then asks the front desk to call.
 */

export const CONDITIONS = {
  diabetes: { label: "Diabetes", intervalDays: 90, pattern: /\b(diabet\w*|t2dm|t1dm|dm\s*(type)?\s*[12i]+|hyperglyc\w*)\b/i },
  hypertension: { label: "Hypertension", intervalDays: 90, pattern: /\b(hypertensi\w*|high blood pressure|htn)\b/i },
  thyroid: { label: "Thyroid", intervalDays: 180, pattern: /\b(hypothyroid\w*|hyperthyroid\w*|thyroid)\b/i },
} as const;
export type Condition = keyof typeof CONDITIONS;
export const isCondition = (v: string): v is Condition => v in CONDITIONS;

/** Reminders go out this many days before the visit is due. */
export const REMIND_BEFORE_DAYS = 3;
/** A second reminder if the patient has not come this many days after the due date. */
export const SECOND_REMINDER_AFTER_DAYS = 7;
/** After this many days overdue a person calls instead. */
export const CALL_AFTER_DAYS = 14;

export function conditionsIn(diagnosis: string | null | undefined): Condition[] {
  if (!diagnosis) return [];
  return (Object.keys(CONDITIONS) as Condition[]).filter((c) => CONDITIONS[c].pattern.test(diagnosis));
}

/**
 * Enrols a patient, or restarts the clock when they come back. Called when a consultation is
 * finished and when the hospital's own HMS reports a visit.
 */
export async function recordCareVisit(
  db: Db,
  input: { patientId: string; condition: Condition; visitDate: string; source?: "clevo" | "hms"; intervalDays?: number },
): Promise<{ planId: string; nextDue: string; enrolled: boolean }> {
  const interval = input.intervalDays ?? CONDITIONS[input.condition].intervalDays;
  const nextDue = addDays(input.visitDate, interval);
  const row = await one<{ plan_id: string; inserted: boolean }>(
    db,
    `INSERT INTO care_plans (plan_id, patient_id, condition, interval_days, last_visit_date, next_due_date, source, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (patient_id, condition) DO UPDATE SET
       last_visit_date = GREATEST(care_plans.last_visit_date, EXCLUDED.last_visit_date),
       next_due_date   = CASE WHEN EXCLUDED.last_visit_date >= care_plans.last_visit_date
                              THEN EXCLUDED.next_due_date ELSE care_plans.next_due_date END,
       reminders_sent  = CASE WHEN EXCLUDED.last_visit_date > care_plans.last_visit_date THEN 0 ELSE care_plans.reminders_sent END,
       status          = CASE WHEN care_plans.status = 'ended' THEN 'active' ELSE care_plans.status END,
       updated_at      = now()
     RETURNING plan_id, (xmax = 0) AS inserted`,
    [newId("CRP"), input.patientId, input.condition, interval, input.visitDate, nextDue, input.source ?? "clevo", newCorrelationId()],
  );
  await audit(db, {
    workflow: "clinic",
    actor: "system",
    action: row!.inserted ? "care.enrolled" : "care.visit_recorded",
    recordId: row!.plan_id,
    details: { condition: input.condition, visit_date: input.visitDate, next_due: nextDue },
  });
  return { planId: row!.plan_id, nextDue, enrolled: row!.inserted };
}

interface DuePlan {
  plan_id: string;
  patient_id: string;
  patient_name: string;
  condition: Condition;
  next_due_date: string;
  reminders_sent: number;
  correlation_id: string | null;
}

/** Sends one recall reminder. Safe to call twice: the message is keyed by plan, due date and attempt. */
export async function remindPlan(planId: string, attempt?: number): Promise<boolean> {
  const p = await one<DuePlan>(
    pool(),
    `SELECT c.plan_id, c.patient_id, p.full_name AS patient_name, c.condition, c.next_due_date::text, c.reminders_sent, c.correlation_id
       FROM care_plans c JOIN patients p ON p.patient_id = c.patient_id
      WHERE c.plan_id = $1 AND c.status = 'active'`,
    [planId],
  );
  if (!p) return false;
  const n = attempt ?? p.reminders_sent + 1;
  const e = env();
  const outcome = await sendTemplateMessage({
    dedupeKey: `msg:care:${p.plan_id}:${p.next_due_date}:${n}`,
    patientId: p.patient_id,
    template: "CARE_RECALL_01",
    workflow: "clinic",
    correlationId: p.correlation_id,
    vars: {
      patient_name: p.patient_name,
      condition: CONDITIONS[p.condition].label.toLowerCase(),
      hospital_name: e.HOSPITAL_NAME,
      due_date: formatDateOnly(p.next_due_date),
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
  await pool().query(
    `UPDATE care_plans SET reminders_sent = GREATEST(reminders_sent, $2), last_reminded_at = now(), updated_at = now() WHERE plan_id = $1`,
    [p.plan_id, n],
  );
  await audit(pool(), { workflow: "clinic", actor: "system", action: "care.reminded", recordId: p.plan_id, details: { attempt: n, status: outcome.status } });
  return true;
}

/**
 * The daily recall pass, run by the worker. First reminder a few days before the due date,
 * a second one a week after it, then a task for the front desk to call.
 */
export async function sweepCare(today = istDateString()): Promise<{ reminded: number; escalated: number }> {
  const db = pool();
  const first = await many<{ plan_id: string }>(
    db,
    `SELECT plan_id FROM care_plans
      WHERE status = 'active' AND reminders_sent = 0 AND next_due_date <= $1::date + $2::int`,
    [today, REMIND_BEFORE_DAYS],
  );
  const second = await many<{ plan_id: string }>(
    db,
    `SELECT plan_id FROM care_plans
      WHERE status = 'active' AND reminders_sent = 1 AND next_due_date <= $1::date - $2::int`,
    [today, SECOND_REMINDER_AFTER_DAYS],
  );
  let reminded = 0;
  for (const r of first) if (await remindPlan(r.plan_id, 1)) reminded++;
  for (const r of second) if (await remindPlan(r.plan_id, 2)) reminded++;

  const overdue = await many<DuePlan>(
    db,
    `SELECT c.plan_id, c.patient_id, p.full_name AS patient_name, c.condition, c.next_due_date::text, c.reminders_sent, c.correlation_id
       FROM care_plans c JOIN patients p ON p.patient_id = c.patient_id
      WHERE c.status = 'active' AND c.reminders_sent >= 2 AND c.next_due_date <= $1::date - $2::int`,
    [today, CALL_AFTER_DAYS],
  );
  let escalated = 0;
  for (const p of overdue) {
    const id = await raiseException(db, {
      workflow: "clinic",
      errorType: "CARE_OVERDUE",
      severity: "medium",
      summary: `${p.patient_name} is overdue for their ${CONDITIONS[p.condition].label.toLowerCase()} review (due ${formatDateOnly(p.next_due_date)}) and has not replied to two reminders. Please call.`,
      recordId: p.plan_id,
      correlationId: p.correlation_id,
      owner: "front_desk",
      dedupeKey: `care-overdue:${p.plan_id}:${p.next_due_date}`,
    });
    if (id) escalated++;
  }
  return { reminded, escalated };
}

export async function setPlanStatus(actorId: string, planId: string, status: "active" | "paused" | "ended"): Promise<void> {
  await tx(async (c) => {
    const r = await c.query(`UPDATE care_plans SET status = $2, updated_at = now() WHERE plan_id = $1`, [planId, status]);
    if (!r.rowCount) throw new Error("That care plan does not exist.");
    await audit(c, { workflow: "clinic", actor: "staff", action: `care.${status}`, recordId: planId, actorId });
  });
}

// --- views ---------------------------------------------------------------------------------------

export interface CarePlanRow {
  plan_id: string;
  patient_id: string;
  patient_name: string;
  uhid: string;
  condition: Condition;
  interval_days: number;
  last_visit_date: string;
  next_due_date: string;
  status: "active" | "paused" | "ended";
  reminders_sent: number;
  last_reminded_at: Date | null;
  source: "clevo" | "hms";
  days_to_due: number;
}

export type CareView = "due" | "overdue" | "all" | "paused";

export async function listCarePlans(db: Db, view: CareView, opts: { condition?: Condition; q?: string; limit?: number } = {}): Promise<CarePlanRow[]> {
  const today = istDateString();
  const where: string[] = [];
  const params: unknown[] = [today];
  if (view === "due") where.push(`c.status = 'active' AND c.next_due_date BETWEEN $1::date - 6 AND $1::date + 14`);
  if (view === "overdue") where.push(`c.status = 'active' AND c.next_due_date < $1::date - 6`);
  if (view === "paused") where.push(`c.status <> 'active'`);
  if (view === "all") where.push(`c.status = 'active'`);
  if (opts.condition) {
    params.push(opts.condition);
    where.push(`c.condition = $${params.length}`);
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim()}%`);
    where.push(`(p.full_name ILIKE $${params.length} OR p.uhid ILIKE $${params.length})`);
  }
  params.push(opts.limit ?? 200);
  return many<CarePlanRow>(
    db,
    `SELECT c.plan_id, c.patient_id, p.full_name AS patient_name, p.uhid, c.condition, c.interval_days,
            c.last_visit_date::text, c.next_due_date::text, c.status, c.reminders_sent, c.last_reminded_at, c.source,
            (c.next_due_date - $1::date)::int AS days_to_due
       FROM care_plans c JOIN patients p ON p.patient_id = c.patient_id
      WHERE ${where.join(" AND ") || "true"}
      ORDER BY ${view === "overdue" ? "c.next_due_date" : view === "all" ? "c.next_due_date" : "abs(c.next_due_date - $1::date)"}, p.full_name
      LIMIT $${params.length}`,
    params,
  );
}

export interface CareStats {
  enrolled: number;
  diabetes: number;
  hypertension: number;
  thyroid: number;
  due_this_week: number;
  overdue: number;
  reminded_30d: number;
  returned_30d: number;
}

export async function careStats(db: Db): Promise<CareStats> {
  const today = istDateString();
  const r = await one<CareStats>(
    db,
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS enrolled,
            count(*) FILTER (WHERE status = 'active' AND condition = 'diabetes')::int AS diabetes,
            count(*) FILTER (WHERE status = 'active' AND condition = 'hypertension')::int AS hypertension,
            count(*) FILTER (WHERE status = 'active' AND condition = 'thyroid')::int AS thyroid,
            count(*) FILTER (WHERE status = 'active' AND next_due_date BETWEEN $1::date AND $1::date + 7)::int AS due_this_week,
            count(*) FILTER (WHERE status = 'active' AND next_due_date < $1::date - 6)::int AS overdue,
            count(*) FILTER (WHERE last_reminded_at > now() - interval '30 days')::int AS reminded_30d,
            count(*) FILTER (WHERE last_visit_date > $1::date - 30 AND created_at < now() - interval '30 days')::int AS returned_30d
       FROM care_plans`,
    [today],
  );
  return r!;
}

/** Enrols every finished consultation whose diagnosis names a chronic condition. */
export async function enrolFromConsultation(db: Db, consultationId: string): Promise<Condition[]> {
  const c = await one<{ patient_id: string; diagnosis: string | null; visit_date: string }>(
    db,
    `SELECT c.patient_id, c.diagnosis, v.visit_date::text FROM consultations c JOIN visits v ON v.visit_id = c.visit_id WHERE c.consultation_id = $1`,
    [consultationId],
  );
  if (!c) return [];
  const found = conditionsIn(c.diagnosis);
  for (const condition of found) await recordCareVisit(db, { patientId: c.patient_id, condition, visitDate: c.visit_date });
  return found;
}

export { istDateString as todayIst };
export const dueLabel = (days: number) =>
  days === 0 ? "due today" : days > 0 ? `due in ${days} day${days === 1 ? "" : "s"}` : `${-days} day${days === -1 ? "" : "s"} overdue`;
export const nextDueAfter = (visitDate: string, condition: Condition) => addDays(visitDate, CONDITIONS[condition].intervalDays);
