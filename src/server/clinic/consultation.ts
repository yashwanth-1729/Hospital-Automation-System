import { z } from "zod";
import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { allergyConflicts, FREQUENCY_CODES, quantityFor, TIMINGS, type AllergyConflict, type Frequency, type Timing } from "@/lib/prescribing";
import { can, type Role } from "@/lib/rbac";
import { addDays, formatDateOnly, isValidDateString, istAt, istDateString } from "@/lib/time";
import { sendTemplateMessage } from "@/server/messaging/send";
import { JOB } from "@/server/workflows/job-types";
import { enrolFromConsultation } from "@/server/care/care";
import { completeVisit } from "./visits";

/** Who is acting. A StaffUser satisfies this. */
export interface Actor {
  user_id: string;
  role: Role;
  doctor_id: string | null;
}

export type ConsultErrorCode =
  | "visit_not_found"
  | "forbidden"
  | "not_your_patient"
  | "not_in_consultation"
  | "already_final"
  | "not_final"
  | "no_record";

export class ConsultError extends Error {
  constructor(
    public readonly code: ConsultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// --- vitals --------------------------------------------------------------------------------

/** A measurement from a form: blank means "not taken", anything else must be a number in range. */
const num = (min: number, max: number, label: string) =>
  z
    .preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
      z.number({ error: `${label} must be a number.` }).min(min, `${label} should be at least ${min}.`).max(max, `${label} should be at most ${max}.`).nullable(),
    )
    .optional();

const VitalsSchema = z.object({
  bp_systolic: num(40, 300, "Systolic pressure"),
  bp_diastolic: num(20, 200, "Diastolic pressure"),
  pulse: num(20, 250, "Pulse"),
  temperature_c: num(30, 45, "Temperature"),
  spo2: num(50, 100, "Oxygen saturation"),
  resp_rate: num(4, 80, "Respiratory rate"),
  weight_kg: num(0.3, 400, "Weight"),
  height_cm: num(20, 260, "Height"),
  notes: z.string().trim().max(500).optional(),
});
export type VitalsInput = Partial<
  Record<"bp_systolic" | "bp_diastolic" | "pulse" | "temperature_c" | "spo2" | "resp_rate" | "weight_kg" | "height_cm", string | number | null>
> & { notes?: string };

export interface VitalsRow {
  vital_id: string;
  recorded_at: Date;
  recorded_by_name: string;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  pulse: number | null;
  temperature_c: number | null;
  spo2: number | null;
  resp_rate: number | null;
  weight_kg: number | null;
  height_cm: number | null;
  notes: string | null;
}

export type FieldErrors = Record<string, string>;

function flatten(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) out[issue.path.join(".") || "_"] ??= issue.message;
  return out;
}

interface VisitRef {
  visit_id: string;
  patient_id: string;
  doctor_id: string;
  status: string;
  correlation_id: string;
}

async function loadVisit(c: Db, visitId: string, lock = false): Promise<VisitRef> {
  const v = await one<VisitRef>(
    c,
    `SELECT visit_id, patient_id, doctor_id, status, correlation_id FROM visits WHERE visit_id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [visitId],
  );
  if (!v) throw new ConsultError("visit_not_found", "That visit does not exist.");
  return v;
}

/** Doctors act on their own patients only; nurses record vitals for anyone in the queue. */
function assertOwnPatient(actor: Actor, visit: VisitRef): void {
  if (actor.role !== "doctor" || !actor.doctor_id || actor.doctor_id !== visit.doctor_id) {
    throw new ConsultError("not_your_patient", "This patient is in another doctor's queue.");
  }
}

export async function recordVitals(
  actor: Actor,
  visitId: string,
  raw: VitalsInput,
): Promise<{ ok: true } | { ok: false; errors: FieldErrors }> {
  if (!can(actor.role, "vitals.record")) throw new ConsultError("forbidden", "Your role cannot record vitals.");
  const parsed = VitalsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: flatten(parsed.error) };
  const d = parsed.data;
  const v = {
    bp_systolic: d.bp_systolic ?? null,
    bp_diastolic: d.bp_diastolic ?? null,
    pulse: d.pulse ?? null,
    temperature_c: d.temperature_c ?? null,
    spo2: d.spo2 ?? null,
    resp_rate: d.resp_rate ?? null,
    weight_kg: d.weight_kg ?? null,
    height_cm: d.height_cm ?? null,
    notes: d.notes,
  };

  const filled = [v.bp_systolic, v.pulse, v.temperature_c, v.spo2, v.resp_rate, v.weight_kg, v.height_cm].some((x) => x !== null);
  if (!filled) return { ok: false, errors: { _: "Enter at least one measurement." } };
  if ((v.bp_systolic === null) !== (v.bp_diastolic === null)) {
    return { ok: false, errors: { bp_diastolic: "Enter both the upper and lower blood pressure." } };
  }
  if (v.bp_systolic !== null && v.bp_diastolic !== null && v.bp_diastolic >= v.bp_systolic) {
    return { ok: false, errors: { bp_diastolic: "The lower pressure must be below the upper." } };
  }

  await tx(async (c) => {
    const visit = await loadVisit(c, visitId);
    if (visit.status !== "waiting" && visit.status !== "in_consultation") {
      throw new ConsultError("not_in_consultation", "Vitals can only be recorded for a patient who is waiting or with the doctor.");
    }
    if (actor.role === "doctor") assertOwnPatient(actor, visit);

    await c.query(
      `INSERT INTO vitals (vital_id, visit_id, patient_id, recorded_by, bp_systolic, bp_diastolic, pulse, temperature_c, spo2,
                           resp_rate, weight_kg, height_cm, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        newId("VIT"), visitId, visit.patient_id, actor.user_id, v.bp_systolic, v.bp_diastolic, v.pulse, v.temperature_c, v.spo2,
        v.resp_rate, v.weight_kg, v.height_cm, v.notes || null,
      ],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "vitals.recorded", recordId: visitId, correlationId: visit.correlation_id });
  });
  return { ok: true };
}

// --- case sheet and prescription -----------------------------------------------------------

const longText = z.string().trim().max(4000).optional().default("");

export const ItemSchema = z.object({
  medicine_id: z.string().trim().optional().nullable(),
  medicine_name: z.string().trim().min(2, "Name the medicine.").max(120),
  dose_units: z.coerce.number().positive("Enter the dose.").max(100),
  frequency: z.enum(FREQUENCY_CODES as [Frequency, ...Frequency[]], { error: "Choose how often." }),
  duration_days: z.coerce.number().int("Whole days only.").min(1, "At least 1 day.").max(365, "At most 365 days."),
  timing: z.enum(Object.keys(TIMINGS) as [Timing, ...Timing[]]).default("any"),
  quantity: z
    .preprocess(
      (v) => (v === "" || v === null || v === undefined ? null : Number(v)),
      z.number({ error: "Enter a whole quantity." }).int("Enter a whole quantity.").min(1, "Enter a whole quantity.").max(10000).nullable(),
    )
    .optional(),
  instructions: z.string().trim().max(200).optional().nullable(),
});
export interface ItemInput {
  medicine_id?: string | null;
  medicine_name: string;
  dose_units?: string | number;
  frequency?: string;
  duration_days?: string | number;
  timing?: string;
  quantity?: string | number | null;
  instructions?: string | null;
}

const FollowUpSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || isValidDateString(v), "Enter a valid date.")
  .refine((v) => v === null || v > istDateString(), "Choose a date after today.")
  .refine((v) => v === null || v <= addDays(istDateString(), 365), "Choose a date within a year.");

export interface ConsultationInput {
  chief_complaint?: string;
  history?: string;
  examination?: string;
  diagnosis?: string;
  advice?: string;
  follow_up_date?: string;
  items?: ItemInput[];
  /** Required, with a reason, when an item conflicts with a recorded allergy. */
  allergy_override_reason?: string;
}

export interface SaveResult {
  ok: boolean;
  errors?: FieldErrors;
  conflicts?: AllergyConflict[];
}

interface CleanItem {
  medicine_id: string | null;
  medicine_name: string;
  dose_units: number;
  frequency: Frequency;
  duration_days: number;
  timing: Timing;
  quantity: number;
  instructions: string | null;
  generic_name: string | null;
}

async function cleanItems(c: Db, items: ItemInput[], strict: boolean): Promise<{ items: CleanItem[]; errors: FieldErrors }> {
  const errors: FieldErrors = {};
  const out: CleanItem[] = [];

  for (const [i, raw] of items.entries()) {
    const blank = !String(raw.medicine_name ?? "").trim();
    if (blank) continue; // An empty row is a row the doctor has not filled yet.
    const parsed = ItemSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors[`items.${i}.${String(issue.path[0] ?? "_")}`] ??= issue.message;
      continue;
    }
    const p = parsed.data;
    const quantity = quantityFor({ doseUnits: p.dose_units, frequency: p.frequency, durationDays: p.duration_days, explicit: p.quantity ?? null });
    if (quantity < 1) {
      errors[`items.${i}.quantity`] = "How many should be dispensed?";
      continue;
    }

    // Link to the formulary when the name matches one, so the pharmacy can find stock.
    let medicineId = p.medicine_id || null;
    let generic: string | null = null;
    const found = medicineId
      ? await one<{ medicine_id: string; generic_name: string }>(c, `SELECT medicine_id, generic_name FROM medicines WHERE medicine_id = $1`, [medicineId])
      : await one<{ medicine_id: string; generic_name: string }>(c, `SELECT medicine_id, generic_name FROM medicines WHERE lower(name) = lower($1)`, [p.medicine_name]);
    if (found) {
      medicineId = found.medicine_id;
      generic = found.generic_name;
    } else {
      medicineId = null;
    }
    out.push({
      medicine_id: medicineId,
      medicine_name: p.medicine_name,
      dose_units: p.dose_units,
      frequency: p.frequency,
      duration_days: p.duration_days,
      timing: p.timing,
      quantity,
      instructions: p.instructions?.trim() || null,
      generic_name: generic,
    });
  }

  if (strict) {
    const names = out.map((o) => `${o.medicine_id ?? o.medicine_name.toLowerCase()}`);
    const dup = names.findIndex((n, i) => names.indexOf(n) !== i);
    if (dup >= 0) errors._ = `${out[dup]!.medicine_name} is listed twice.`;
  }
  return { items: out, errors };
}

async function writeConsultation(
  actor: Actor,
  visitId: string,
  input: ConsultationInput,
  mode: "draft" | "final",
): Promise<SaveResult & { consultationId?: string }> {
  assertDoctorRole(actor);

  const followUp = FollowUpSchema.safeParse(input.follow_up_date);
  const text = z
    .object({
      chief_complaint: longText,
      history: longText,
      examination: longText,
      diagnosis: longText,
      advice: longText,
    })
    .parse({
      chief_complaint: input.chief_complaint,
      history: input.history,
      examination: input.examination,
      diagnosis: input.diagnosis,
      advice: input.advice,
    });

  const errors: FieldErrors = {};
  if (!followUp.success) errors.follow_up_date = followUp.error.issues[0]!.message;
  if (mode === "final" && !text.diagnosis) errors.diagnosis = "Record the diagnosis before finishing.";
  if (mode === "final" && !text.chief_complaint) errors.chief_complaint = "Record why the patient came.";

  return tx(async (c) => {
    const visit = await loadVisit(c, visitId, true);
    assertOwnPatient(actor, visit);
    if (visit.status !== "in_consultation") {
      throw new ConsultError("not_in_consultation", "Call the patient in before writing the consultation.");
    }
    const existing = await one<{ consultation_id: string; status: string }>(
      c,
      `SELECT consultation_id, status FROM consultations WHERE visit_id = $1 FOR UPDATE`,
      [visitId],
    );
    if (existing?.status === "final") throw new ConsultError("already_final", "This consultation is finished. Add an addendum instead.");

    const { items, errors: itemErrors } = await cleanItems(c, input.items ?? [], mode === "final");
    Object.assign(errors, itemErrors);

    const patient = await one<{ allergies: string | null }>(c, `SELECT allergies FROM patients WHERE patient_id = $1`, [visit.patient_id]);
    const conflicts = allergyConflicts(
      patient?.allergies,
      items.map((i) => ({ medicine_name: i.medicine_name, generic_name: i.generic_name })),
    );
    const override = input.allergy_override_reason?.trim() ?? "";
    if (mode === "final" && conflicts.length && override.length < 5) {
      errors.allergy_override_reason = "State why this is safe, or remove the medicine.";
    }
    if (Object.keys(errors).length) return { ok: false, errors, conflicts };

    const consultationId = existing?.consultation_id ?? newId("CON");
    if (existing) {
      await c.query(
        `UPDATE consultations SET chief_complaint = $2, history = $3, examination = $4, diagnosis = $5, advice = $6,
                follow_up_date = $7, updated_at = now()
          WHERE consultation_id = $1`,
        [consultationId, text.chief_complaint, text.history, text.examination, text.diagnosis, text.advice, followUp.data ?? null],
      );
    } else {
      await c.query(
        `INSERT INTO consultations (consultation_id, visit_id, patient_id, doctor_id, written_by, chief_complaint, history,
                                    examination, diagnosis, advice, follow_up_date, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          consultationId, visitId, visit.patient_id, visit.doctor_id, actor.user_id, text.chief_complaint, text.history,
          text.examination, text.diagnosis, text.advice, followUp.data ?? null, visit.correlation_id,
        ],
      );
    }

    // The prescription is rewritten whole: items are small and order matters.
    const rx = await one<{ prescription_id: string }>(c, `SELECT prescription_id FROM prescriptions WHERE consultation_id = $1 FOR UPDATE`, [
      consultationId,
    ]);
    if (items.length === 0) {
      if (rx) await c.query(`DELETE FROM prescriptions WHERE prescription_id = $1`, [rx.prescription_id]);
    } else {
      const prescriptionId = rx?.prescription_id ?? newId("RX");
      if (!rx) {
        await c.query(
          `INSERT INTO prescriptions (prescription_id, consultation_id, visit_id, patient_id, doctor_id, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [prescriptionId, consultationId, visitId, visit.patient_id, visit.doctor_id, visit.correlation_id],
        );
      }
      await c.query(`DELETE FROM prescription_items WHERE prescription_id = $1`, [prescriptionId]);
      for (const [position, it] of items.entries()) {
        await c.query(
          `INSERT INTO prescription_items (item_id, prescription_id, position, medicine_id, medicine_name, dose_units, frequency,
                                           duration_days, timing, quantity, instructions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [newId("RXI"), prescriptionId, position + 1, it.medicine_id, it.medicine_name, it.dose_units, it.frequency, it.duration_days,
           it.timing, it.quantity, it.instructions],
        );
      }
      await c.query(`UPDATE prescriptions SET allergy_override_reason = $2, updated_at = now() WHERE prescription_id = $1`, [
        prescriptionId,
        conflicts.length ? override || null : null,
      ]);
    }

    if (mode === "draft") {
      await audit(c, { workflow: "clinic", actor: "staff", action: "consultation.draft_saved", recordId: visitId, correlationId: visit.correlation_id });
      return { ok: true, consultationId, conflicts };
    }

    // --- finishing: lock the record, issue the prescription, free the doctor, tell the patient ---
    await c.query(`UPDATE consultations SET status = 'final', finalised_at = now(), updated_at = now() WHERE consultation_id = $1`, [consultationId]);
    if (items.length) {
      await c.query(
        `UPDATE prescriptions SET status = 'issued', issued_at = now(), updated_at = now() WHERE consultation_id = $1`,
        [consultationId],
      );
    }
    await completeVisit(c, visitId);
    // A chronic diagnosis puts the patient on a repeat-visit plan, or restarts its clock.
    await enrolFromConsultation(c, consultationId);
    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "consultation.finalised",
      recordId: consultationId,
      correlationId: visit.correlation_id,
      details: { items: items.length, allergy_override: conflicts.length > 0, follow_up_date: followUp.data ?? null },
    });

    const e = env();
    const doctor = await one<{ full_name: string }>(c, `SELECT full_name FROM doctors WHERE doctor_id = $1`, [visit.doctor_id]);
    const patientRow = await one<{ full_name: string }>(c, `SELECT full_name FROM patients WHERE patient_id = $1`, [visit.patient_id]);
    await enqueue(c, {
      type: JOB.messageSend,
      payload: {
        dedupe_key: `msg:${consultationId}:CONSULT_COMPLETE_01`,
        patient_id: visit.patient_id,
        template: "CONSULT_COMPLETE_01",
        workflow: "clinic",
        vars: {
          patient_name: patientRow!.full_name,
          hospital_name: e.HOSPITAL_NAME,
          doctor_name: doctor!.full_name,
          next_step: items.length ? "Your prescription is ready at our pharmacy counter." : "No medicines were prescribed.",
          hospital_contact: e.HOSPITAL_CONTACT,
        },
      },
      dedupeKey: `consult.complete:${consultationId}`,
      correlationId: visit.correlation_id,
    });
    if (followUp.data) {
      const dayBefore = new Date(istAt(addDays(followUp.data, -1), e.FOLLOWUP_REMINDER_HOUR));
      await enqueue(c, {
        type: JOB.consultFollowupReminder,
        payload: { consultation_id: consultationId, followup_date: followUp.data },
        runAt: dayBefore > new Date() ? dayBefore : new Date(),
        dedupeKey: `consult.followup:${consultationId}:${followUp.data}`,
        correlationId: visit.correlation_id,
      });
    }
    return { ok: true, consultationId, conflicts };
  });
}

function assertDoctorRole(actor: Actor): void {
  if (!can(actor.role, "consult.write")) throw new ConsultError("forbidden", "Only a doctor can write a consultation.");
}

export function saveDraft(actor: Actor, visitId: string, input: ConsultationInput): Promise<SaveResult> {
  return writeConsultation(actor, visitId, input, "draft");
}

export function finaliseConsultation(actor: Actor, visitId: string, input: ConsultationInput): Promise<SaveResult> {
  return writeConsultation(actor, visitId, input, "final");
}

export async function addAddendum(actor: Actor, consultationId: string, note: string): Promise<void> {
  assertDoctorRole(actor);
  const text = note.trim().slice(0, 2000);
  if (!text) throw new ConsultError("no_record", "Write the note first.");
  await tx(async (c) => {
    const con = await one<{ doctor_id: string; status: string; correlation_id: string }>(
      c,
      `SELECT doctor_id, status, correlation_id FROM consultations WHERE consultation_id = $1`,
      [consultationId],
    );
    if (!con) throw new ConsultError("no_record", "That consultation does not exist.");
    if (con.status !== "final") throw new ConsultError("not_final", "Finish the consultation first; until then, edit it directly.");
    if (con.doctor_id !== actor.doctor_id) throw new ConsultError("not_your_patient", "Only the treating doctor can add to this record.");
    await c.query(`INSERT INTO consultation_addenda (addendum_id, consultation_id, written_by, note) VALUES ($1, $2, $3, $4)`, [
      newId("ADD"),
      consultationId,
      actor.user_id,
      text,
    ]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "consultation.addendum", recordId: consultationId, correlationId: con.correlation_id });
  });
}

// --- reading ---------------------------------------------------------------------------------

export interface PrescriptionItemRow {
  item_id: string;
  position: number;
  medicine_id: string | null;
  medicine_name: string;
  dose_units: number;
  frequency: Frequency;
  duration_days: number;
  timing: Timing;
  quantity: number;
  instructions: string | null;
  dispensed_qty: number;
  unit: string | null;
}

export interface ConsultationRow {
  consultation_id: string;
  chief_complaint: string | null;
  history: string | null;
  examination: string | null;
  diagnosis: string | null;
  advice: string | null;
  follow_up_date: string | null;
  status: "draft" | "final";
  finalised_at: Date | null;
  doctor_name: string;
  visit_date: string;
  prescription_status: string | null;
  allergy_override_reason: string | null;
  items: PrescriptionItemRow[];
  addenda: { note: string; created_at: Date; author: string }[];
}

async function loadConsultations(db: Db, where: string, params: unknown[]): Promise<ConsultationRow[]> {
  const rows = await many<Omit<ConsultationRow, "items" | "addenda"> & { prescription_id: string | null }>(
    db,
    `SELECT c.consultation_id, c.chief_complaint, c.history, c.examination, c.diagnosis, c.advice, c.follow_up_date, c.status,
            c.finalised_at, d.full_name AS doctor_name, v.visit_date, rx.status AS prescription_status,
            rx.allergy_override_reason, rx.prescription_id
       FROM consultations c
       JOIN visits v ON v.visit_id = c.visit_id
       JOIN doctors d ON d.doctor_id = c.doctor_id
       LEFT JOIN prescriptions rx ON rx.consultation_id = c.consultation_id
      WHERE ${where}
      ORDER BY v.visit_date DESC, c.created_at DESC`,
    params,
  );
  const out: ConsultationRow[] = [];
  for (const r of rows) {
    const items = r.prescription_id
      ? await many<PrescriptionItemRow>(
          db,
          `SELECT i.item_id, i.position, i.medicine_id, i.medicine_name, i.dose_units::float AS dose_units, i.frequency,
                  i.duration_days, i.timing, i.quantity, i.instructions, i.dispensed_qty, m.unit
             FROM prescription_items i LEFT JOIN medicines m ON m.medicine_id = i.medicine_id
            WHERE i.prescription_id = $1 ORDER BY i.position`,
          [r.prescription_id],
        )
      : [];
    const addenda = await many<{ note: string; created_at: Date; author: string }>(
      db,
      `SELECT a.note, a.created_at, u.full_name AS author
         FROM consultation_addenda a JOIN staff_users u ON u.user_id = a.written_by
        WHERE a.consultation_id = $1 ORDER BY a.created_at`,
      [r.consultation_id],
    );
    const { prescription_id: _id, ...rest } = r;
    void _id;
    out.push({ ...rest, items, addenda });
  }
  return out;
}

export async function getConsultationForVisit(db: Db, visitId: string): Promise<ConsultationRow | null> {
  return (await loadConsultations(db, `c.visit_id = $1`, [visitId]))[0] ?? null;
}

/** Earlier finished consultations for the patient, newest first: what the doctor reads before the next one. */
export async function patientHistory(db: Db, patientId: string, opts: { excludeVisitId?: string; limit?: number } = {}): Promise<ConsultationRow[]> {
  const all = await loadConsultations(db, `c.patient_id = $1 AND c.status = 'final' AND ($2::text IS NULL OR c.visit_id <> $2)`, [
    patientId,
    opts.excludeVisitId ?? null,
  ]);
  return all.slice(0, opts.limit ?? 10);
}

export async function visitVitals(db: Db, visitId: string): Promise<VitalsRow[]> {
  return many<VitalsRow>(
    db,
    `SELECT v.vital_id, v.recorded_at, u.full_name AS recorded_by_name, v.bp_systolic, v.bp_diastolic, v.pulse,
            v.temperature_c::float AS temperature_c, v.spo2, v.resp_rate, v.weight_kg::float AS weight_kg,
            v.height_cm::float AS height_cm, v.notes
       FROM vitals v JOIN staff_users u ON u.user_id = v.recorded_by
      WHERE v.visit_id = $1 ORDER BY v.recorded_at DESC`,
    [visitId],
  );
}

/** The patient's most recent weight and height across visits: children and elderly doses depend on them. */
export async function latestBody(db: Db, patientId: string): Promise<{ weight_kg: number | null; height_cm: number | null }> {
  const r = await one<{ weight_kg: number | null; height_cm: number | null }>(
    db,
    `SELECT (SELECT weight_kg::float FROM vitals WHERE patient_id = $1 AND weight_kg IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS weight_kg,
            (SELECT height_cm::float FROM vitals WHERE patient_id = $1 AND height_cm IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS height_cm`,
    [patientId],
  );
  return r ?? { weight_kg: null, height_cm: null };
}

export async function searchFormulary(db: Db, query: string, limit = 12): Promise<{ medicine_id: string; name: string; generic_name: string; form: string; unit: string }[]> {
  const like = `%${query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return many(
    db,
    `SELECT medicine_id, name, generic_name, form, unit FROM medicines
      WHERE active AND (name ILIKE $1 OR generic_name ILIKE $1) ORDER BY name LIMIT $2`,
    [like, limit],
  );
}

/** Reminder for an outpatient follow-up date. Skipped if the doctor changed the date since. */
export async function sendConsultFollowupReminder(consultationId: string, followupDate: string): Promise<void> {
  const e = env();
  const row = await one<{ patient_id: string; patient_name: string; follow_up_date: string | null; correlation_id: string }>(
    pool(),
    `SELECT c.patient_id, p.full_name AS patient_name, c.follow_up_date, c.correlation_id
       FROM consultations c JOIN patients p ON p.patient_id = c.patient_id WHERE c.consultation_id = $1`,
    [consultationId],
  );
  if (!row) throw new Error(`Consultation ${consultationId} not found`);
  if (row.follow_up_date !== followupDate) return;

  await sendTemplateMessage({
    dedupeKey: `msg:${consultationId}:FOLLOWUP_REMINDER_01:${followupDate}`,
    patientId: row.patient_id,
    template: "FOLLOWUP_REMINDER_01",
    workflow: "clinic",
    correlationId: row.correlation_id,
    vars: {
      patient_name: row.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      followup_date: formatDateOnly(followupDate),
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
}
