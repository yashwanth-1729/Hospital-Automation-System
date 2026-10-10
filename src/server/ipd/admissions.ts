import { audit } from "@/lib/audit";
import { many, one, tx, type Db } from "@/lib/db";
import { newCorrelationId, newId } from "@/lib/ids";
import { can, type Capability } from "@/lib/rbac";
import { isValidDateString, istDateString } from "@/lib/time";
import type { Actor } from "@/server/clinic/consultation";
import { recordDischarge } from "@/server/workflows/discharge";

export type IpdErrorCode =
  | "forbidden"
  | "not_found"
  | "bed_unavailable"
  | "already_admitted"
  | "wrong_state"
  | "validation"
  | "same_bed"
  | "discharge_failed";

export class IpdError extends Error {
  constructor(
    public readonly code: IpdErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function need(actor: Actor, capability: Capability, message: string): void {
  if (!can(actor.role, capability)) throw new IpdError("forbidden", message);
}

// --- the board ---------------------------------------------------------------------------------

export interface BedRow {
  bed_id: string;
  label: string;
  status: "available" | "occupied" | "cleaning" | "maintenance";
  admission_id: string | null;
  patient_id: string | null;
  patient_name: string | null;
  uhid: string | null;
  date_of_birth: string | null;
  dob_estimated: boolean | null;
  doctor_name: string | null;
  admitted_at: Date | null;
  expected_discharge: string | null;
  reason: string | null;
}

export interface WardBoard {
  ward_id: string;
  name: string;
  kind: string;
  daily_rate: number;
  beds: BedRow[];
}

export async function bedBoard(db: Db): Promise<WardBoard[]> {
  const wards = await many<Omit<WardBoard, "beds">>(
    db,
    `SELECT ward_id, name, kind, daily_rate::float AS daily_rate FROM wards WHERE active ORDER BY kind, name`,
  );
  const beds = await many<BedRow & { ward_id: string }>(
    db,
    `SELECT b.bed_id, b.ward_id, b.label, b.status, a.admission_id, p.patient_id, p.full_name AS patient_name, p.uhid,
            p.date_of_birth, p.dob_estimated, d.full_name AS doctor_name, a.admitted_at, a.expected_discharge, a.reason
       FROM beds b
       LEFT JOIN bed_stays s ON s.bed_id = b.bed_id AND s.ended_at IS NULL
       LEFT JOIN admissions a ON a.admission_id = s.admission_id
       LEFT JOIN patients p ON p.patient_id = a.patient_id
       LEFT JOIN doctors d ON d.doctor_id = a.doctor_id
      WHERE b.active
      ORDER BY b.ward_id, b.label`,
  );
  return wards.map((w) => ({ ...w, beds: beds.filter((b) => b.ward_id === w.ward_id) }));
}

export interface AdmissionRow {
  admission_id: string;
  status: "admitted" | "discharged";
  patient_id: string;
  patient_name: string;
  uhid: string;
  date_of_birth: string | null;
  dob_estimated: boolean;
  allergies: string | null;
  doctor_id: string;
  doctor_name: string;
  department: string;
  reason: string | null;
  expected_discharge: string | null;
  admitted_at: Date;
  discharged_at: Date | null;
  ward_name: string | null;
  bed_label: string | null;
  bed_id: string | null;
  discharge_id: string | null;
}

export async function listAdmissions(db: Db, opts: { status?: "admitted" | "discharged"; limit?: number } = {}): Promise<AdmissionRow[]> {
  return many<AdmissionRow>(
    db,
    `SELECT a.admission_id, a.status, p.patient_id, p.full_name AS patient_name, p.uhid, p.date_of_birth, p.dob_estimated,
            p.allergies, d.doctor_id, d.full_name AS doctor_name, dep.name AS department, a.reason, a.expected_discharge,
            a.admitted_at, a.discharged_at, w.name AS ward_name, b.label AS bed_label, b.bed_id, a.discharge_id
       FROM admissions a
       JOIN patients p ON p.patient_id = a.patient_id
       JOIN doctors d ON d.doctor_id = a.doctor_id
       JOIN departments dep ON dep.department_id = a.department_id
       LEFT JOIN LATERAL (
         SELECT * FROM bed_stays s WHERE s.admission_id = a.admission_id ORDER BY s.started_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN beds b ON b.bed_id = s.bed_id
       LEFT JOIN wards w ON w.ward_id = s.ward_id
      WHERE ($1::text IS NULL OR a.status = $1)
      ORDER BY a.status, a.admitted_at DESC
      LIMIT $2`,
    [opts.status ?? null, opts.limit ?? 100],
  );
}

export async function getAdmission(db: Db, admissionId: string): Promise<(AdmissionRow & { stays: StayRow[] }) | null> {
  const rows = await many<AdmissionRow>(
    db,
    `SELECT a.admission_id, a.status, p.patient_id, p.full_name AS patient_name, p.uhid, p.date_of_birth, p.dob_estimated,
            p.allergies, d.doctor_id, d.full_name AS doctor_name, dep.name AS department, a.reason, a.expected_discharge,
            a.admitted_at, a.discharged_at, w.name AS ward_name, b.label AS bed_label, b.bed_id, a.discharge_id
       FROM admissions a
       JOIN patients p ON p.patient_id = a.patient_id
       JOIN doctors d ON d.doctor_id = a.doctor_id
       JOIN departments dep ON dep.department_id = a.department_id
       LEFT JOIN LATERAL (
         SELECT * FROM bed_stays s WHERE s.admission_id = a.admission_id ORDER BY s.started_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN beds b ON b.bed_id = s.bed_id
       LEFT JOIN wards w ON w.ward_id = s.ward_id
      WHERE a.admission_id = $1`,
    [admissionId],
  );
  if (!rows[0]) return null;
  return { ...rows[0], stays: await staysFor(db, admissionId) };
}

export interface StayRow {
  stay_id: string;
  bed_id: string;
  ward_name: string;
  bed_label: string;
  daily_rate: number;
  started_at: Date;
  ended_at: Date | null;
  ended_reason: "transfer" | "discharge" | null;
}

export async function staysFor(db: Db, admissionId: string): Promise<StayRow[]> {
  return many<StayRow>(
    db,
    `SELECT s.stay_id, s.bed_id, w.name AS ward_name, b.label AS bed_label, s.daily_rate::float AS daily_rate,
            s.started_at, s.ended_at, s.ended_reason
       FROM bed_stays s JOIN beds b ON b.bed_id = s.bed_id JOIN wards w ON w.ward_id = s.ward_id
      WHERE s.admission_id = $1 ORDER BY s.started_at`,
    [admissionId],
  );
}

/** Beds that can take a patient right now, with their ward and rate. */
export async function availableBeds(db: Db): Promise<{ bed_id: string; label: string; ward_name: string; daily_rate: number }[]> {
  return many(
    db,
    `SELECT b.bed_id, b.label, w.name AS ward_name, w.daily_rate::float AS daily_rate
       FROM beds b JOIN wards w ON w.ward_id = b.ward_id
      WHERE b.active AND w.active AND b.status = 'available'
      ORDER BY w.kind, w.name, b.label`,
  );
}

// --- admitting, moving, discharging ------------------------------------------------------------------

export async function admitPatient(
  actor: Actor,
  input: { patientId: string; bedId: string; doctorId: string; reason?: string; expectedDischarge?: string | null },
): Promise<{ admissionId: string }> {
  need(actor, "ipd.admit", "Your role cannot admit patients.");
  const reason = input.reason?.trim().slice(0, 300) || null;
  const expected = input.expectedDischarge?.trim() || null;
  if (expected && (!isValidDateString(expected) || expected < istDateString())) {
    throw new IpdError("validation", "The expected discharge date cannot be in the past.");
  }

  return tx(async (c) => {
    const patient = await one(c, `SELECT 1 FROM patients WHERE patient_id = $1`, [input.patientId]);
    if (!patient) throw new IpdError("not_found", "That patient does not exist.");
    const doctor = await one<{ department_id: string }>(c, `SELECT department_id FROM doctors WHERE doctor_id = $1 AND active`, [input.doctorId]);
    if (!doctor) throw new IpdError("not_found", "Choose a doctor who is currently practising.");

    const already = await one(c, `SELECT 1 FROM admissions WHERE patient_id = $1 AND status = 'admitted'`, [input.patientId]);
    if (already) throw new IpdError("already_admitted", "This patient is already admitted.");

    const bed = await one<{ status: string; ward_id: string; daily_rate: number }>(
      c,
      `SELECT b.status, b.ward_id, w.daily_rate::float AS daily_rate FROM beds b JOIN wards w ON w.ward_id = b.ward_id
        WHERE b.bed_id = $1 AND b.active FOR UPDATE OF b`,
      [input.bedId],
    );
    if (!bed) throw new IpdError("not_found", "That bed does not exist.");
    if (bed.status !== "available") throw new IpdError("bed_unavailable", `That bed is ${bed.status}.`);

    const admissionId = newId("ADM");
    const correlationId = newCorrelationId();
    await c.query(
      `INSERT INTO admissions (admission_id, patient_id, doctor_id, department_id, reason, expected_discharge, admitted_by, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [admissionId, input.patientId, input.doctorId, doctor.department_id, reason, expected, actor.user_id, correlationId],
    );
    await c.query(`INSERT INTO bed_stays (stay_id, admission_id, bed_id, ward_id, daily_rate) VALUES ($1, $2, $3, $4, $5)`, [
      newId("STY"),
      admissionId,
      input.bedId,
      bed.ward_id,
      bed.daily_rate,
    ]);
    await c.query(`UPDATE beds SET status = 'occupied' WHERE bed_id = $1`, [input.bedId]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "admission.admitted", recordId: admissionId, correlationId, details: { bed_id: input.bedId } });
    return { admissionId };
  });
}

export async function transferBed(actor: Actor, admissionId: string, newBedId: string): Promise<void> {
  need(actor, "ipd.transfer", "Your role cannot move patients between beds.");
  await tx(async (c) => {
    const adm = await one<{ status: string; correlation_id: string }>(
      c,
      `SELECT status, correlation_id FROM admissions WHERE admission_id = $1 FOR UPDATE`,
      [admissionId],
    );
    if (!adm) throw new IpdError("not_found", "That admission does not exist.");
    if (adm.status !== "admitted") throw new IpdError("wrong_state", "This patient has been discharged.");

    const stay = await one<{ stay_id: string; bed_id: string }>(
      c,
      `SELECT stay_id, bed_id FROM bed_stays WHERE admission_id = $1 AND ended_at IS NULL FOR UPDATE`,
      [admissionId],
    );
    if (!stay) throw new IpdError("wrong_state", "This admission has no bed.");
    if (stay.bed_id === newBedId) throw new IpdError("same_bed", "The patient is already in that bed.");

    // Both beds are locked in id order, so two simultaneous transfers cannot deadlock.
    const ids = [stay.bed_id, newBedId].sort();
    await many(c, `SELECT bed_id FROM beds WHERE bed_id = ANY($1::text[]) ORDER BY bed_id FOR UPDATE`, [ids]);

    const target = await one<{ status: string; ward_id: string; daily_rate: number }>(
      c,
      `SELECT b.status, b.ward_id, w.daily_rate::float AS daily_rate FROM beds b JOIN wards w ON w.ward_id = b.ward_id
        WHERE b.bed_id = $1 AND b.active`,
      [newBedId],
    );
    if (!target) throw new IpdError("not_found", "That bed does not exist.");
    if (target.status !== "available") throw new IpdError("bed_unavailable", `That bed is ${target.status}.`);

    await c.query(`UPDATE bed_stays SET ended_at = now(), ended_reason = 'transfer' WHERE stay_id = $1`, [stay.stay_id]);
    await c.query(`UPDATE beds SET status = 'cleaning' WHERE bed_id = $1`, [stay.bed_id]);
    await c.query(`INSERT INTO bed_stays (stay_id, admission_id, bed_id, ward_id, daily_rate) VALUES ($1, $2, $3, $4, $5)`, [
      newId("STY"),
      admissionId,
      newBedId,
      target.ward_id,
      target.daily_rate,
    ]);
    await c.query(`UPDATE beds SET status = 'occupied' WHERE bed_id = $1`, [newBedId]);
    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "admission.transferred",
      recordId: admissionId,
      correlationId: adm.correlation_id,
      details: { from: stay.bed_id, to: newBedId },
    });
  });
}

export interface DischargeInput {
  followUpDate?: string | null;
  /** Doctor who approved the follow-up date; required when a date is given. */
  approvedBy?: string | null;
}

/**
 * Discharges the patient, frees the bed for cleaning, and hands over to the discharge
 * follow-up workflow, which schedules the reminder and the feedback request.
 */
export async function dischargeAdmission(actor: Actor, admissionId: string, input: DischargeInput = {}): Promise<{ dischargeId: string | null }> {
  need(actor, "ipd.discharge", "Your role cannot discharge patients.");
  const followUp = input.followUpDate?.trim() || null;
  if (followUp && !isValidDateString(followUp)) throw new IpdError("validation", "Enter a valid follow-up date.");
  if (followUp && followUp < istDateString()) throw new IpdError("validation", "The follow-up date cannot be in the past.");
  if (followUp && !input.approvedBy?.trim()) throw new IpdError("validation", "Say which doctor approved the follow-up date.");

  const snapshot = await tx(async (c) => {
    const adm = await one<{ status: string; patient_id: string; department_id: string; correlation_id: string }>(
      c,
      `SELECT status, patient_id, department_id, correlation_id FROM admissions WHERE admission_id = $1 FOR UPDATE`,
      [admissionId],
    );
    if (!adm) throw new IpdError("not_found", "That admission does not exist.");
    if (adm.status !== "admitted") throw new IpdError("wrong_state", "This patient has already been discharged.");

    const stay = await one<{ stay_id: string; bed_id: string }>(
      c,
      `SELECT stay_id, bed_id FROM bed_stays WHERE admission_id = $1 AND ended_at IS NULL FOR UPDATE`,
      [admissionId],
    );
    if (stay) {
      await c.query(`UPDATE bed_stays SET ended_at = now(), ended_reason = 'discharge' WHERE stay_id = $1`, [stay.stay_id]);
      await c.query(`UPDATE beds SET status = 'cleaning' WHERE bed_id = $1`, [stay.bed_id]);
    }
    await c.query(`UPDATE admissions SET status = 'discharged', discharged_at = now(), discharged_by = $2 WHERE admission_id = $1`, [
      admissionId,
      actor.user_id,
    ]);
    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "admission.discharged",
      recordId: admissionId,
      correlationId: adm.correlation_id,
      details: { follow_up_date: followUp },
    });
    const patient = await one<{ full_name: string; phone: string }>(c, `SELECT full_name, phone FROM patients WHERE patient_id = $1`, [adm.patient_id]);
    const dept = await one<{ name: string }>(c, `SELECT name FROM departments WHERE department_id = $1`, [adm.department_id]);
    return { patient: patient!, department: dept!.name, correlationId: adm.correlation_id };
  });

  // The follow-up and feedback automation. It is idempotent per encounter, so a retry is safe.
  const result = await recordDischarge({
    full_name: snapshot.patient.full_name,
    phone: snapshot.patient.phone,
    encounter_id: admissionId,
    department: snapshot.department,
    approved_followup_date: followUp,
    approved_by: followUp ? input.approvedBy!.trim() : null,
    source: "staff",
  });
  if (!result.ok) {
    // The bed is already free and the patient discharged; only the messaging hand-off failed.
    throw new IpdError("discharge_failed", `Discharged, but the follow-up could not be scheduled: ${Object.values(result.errors)[0]}`);
  }
  await tx((c) => c.query(`UPDATE admissions SET discharge_id = $2 WHERE admission_id = $1`, [admissionId, result.dischargeId]));
  return { dischargeId: result.dischargeId };
}

// --- beds -------------------------------------------------------------------------------------------

export async function markBedReady(actor: Actor, bedId: string): Promise<void> {
  need(actor, "ipd.beds", "Your role cannot change bed status.");
  const r = await tx((c) => c.query(`UPDATE beds SET status = 'available' WHERE bed_id = $1 AND status = 'cleaning'`, [bedId]));
  if (!r.rowCount) throw new IpdError("wrong_state", "Only a bed that is being cleaned can be marked ready.");
}

export async function setBedMaintenance(actor: Actor, bedId: string, on: boolean): Promise<void> {
  need(actor, "ipd.beds", "Your role cannot change bed status.");
  const r = await tx((c) =>
    on
      ? c.query(`UPDATE beds SET status = 'maintenance' WHERE bed_id = $1 AND status IN ('available', 'cleaning')`, [bedId])
      : c.query(`UPDATE beds SET status = 'available' WHERE bed_id = $1 AND status = 'maintenance'`, [bedId]),
  );
  if (!r.rowCount) throw new IpdError("wrong_state", on ? "Only an empty bed can go for maintenance." : "That bed is not under maintenance.");
}

export async function addWard(actor: Actor, input: { name: string; kind: string; dailyRate: number; beds: number }): Promise<{ wardId: string }> {
  need(actor, "ipd.configure", "Only an administrator can add wards.");
  const name = input.name.trim();
  if (name.length < 2) throw new IpdError("validation", "Name the ward.");
  if (!["general", "semi_private", "private", "icu", "day_care"].includes(input.kind)) throw new IpdError("validation", "Choose a ward type.");
  if (!Number.isFinite(input.dailyRate) || input.dailyRate < 0) throw new IpdError("validation", "Enter the daily rate.");
  if (!Number.isInteger(input.beds) || input.beds < 1 || input.beds > 200) throw new IpdError("validation", "A ward needs between 1 and 200 beds.");

  return tx(async (c) => {
    const clash = await one(c, `SELECT 1 FROM wards WHERE lower(name) = lower($1)`, [name]);
    if (clash) throw new IpdError("validation", "A ward with that name already exists.");
    const wardId = newId("WRD");
    await c.query(`INSERT INTO wards (ward_id, name, kind, daily_rate) VALUES ($1, $2, $3, $4)`, [wardId, name, input.kind, input.dailyRate]);
    const prefix = name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "B";
    for (let i = 1; i <= input.beds; i++) {
      await c.query(`INSERT INTO beds (bed_id, ward_id, label) VALUES ($1, $2, $3)`, [newId("BED"), wardId, `${prefix}-${String(i).padStart(2, "0")}`]);
    }
    await audit(c, { workflow: "clinic", actor: "staff", action: "ward.added", recordId: wardId, details: { beds: input.beds } });
    return { wardId };
  });
}

// --- billing the stay ------------------------------------------------------------------------------

export interface OccupancyRow {
  ward_id: string;
  name: string;
  total: number;
  occupied: number;
  available: number;
  cleaning: number;
  maintenance: number;
}

export async function occupancy(db: Db): Promise<OccupancyRow[]> {
  return many<OccupancyRow>(
    db,
    `SELECT w.ward_id, w.name,
            count(b.bed_id)::int AS total,
            count(*) FILTER (WHERE b.status = 'occupied')::int AS occupied,
            count(*) FILTER (WHERE b.status = 'available')::int AS available,
            count(*) FILTER (WHERE b.status = 'cleaning')::int AS cleaning,
            count(*) FILTER (WHERE b.status = 'maintenance')::int AS maintenance
       FROM wards w LEFT JOIN beds b ON b.ward_id = w.ward_id AND b.active
      WHERE w.active GROUP BY w.ward_id ORDER BY w.name`,
  );
}
