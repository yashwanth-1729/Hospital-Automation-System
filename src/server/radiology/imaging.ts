import { audit } from "@/lib/audit";
import { many, one, tx, type Db } from "@/lib/db";
import { newCorrelationId, newId } from "@/lib/ids";
import { can, type Capability } from "@/lib/rbac";
import type { Actor } from "@/server/clinic/consultation";

export type ImagingErrorCode = "forbidden" | "not_found" | "not_your_patient" | "wrong_state" | "validation";

export class ImagingError extends Error {
  constructor(
    public readonly code: ImagingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function need(actor: Actor, capability: Capability, message: string): void {
  if (!can(actor.role, capability)) throw new ImagingError("forbidden", message);
}

export const MODALITIES = {
  xray: "X-ray",
  ultrasound: "Ultrasound",
  ct: "CT scan",
  mri: "MRI",
  ecg: "ECG",
  other: "Other",
} as const;
export type Modality = keyof typeof MODALITIES;

/** Common studies, so the doctor picks rather than types. Anything else can be written in. */
export const STUDY_CATALOGUE: { study: string; modality: Modality }[] = [
  { study: "Chest X-ray", modality: "xray" },
  { study: "X-ray knee", modality: "xray" },
  { study: "X-ray spine, lumbar", modality: "xray" },
  { study: "X-ray abdomen", modality: "xray" },
  { study: "Ultrasound abdomen", modality: "ultrasound" },
  { study: "Ultrasound pelvis", modality: "ultrasound" },
  { study: "Echocardiogram", modality: "ultrasound" },
  { study: "CT head", modality: "ct" },
  { study: "CT chest", modality: "ct" },
  { study: "MRI brain", modality: "mri" },
  { study: "MRI spine", modality: "mri" },
  { study: "ECG, 12 lead", modality: "ecg" },
];

export type ImagingStatus = "ordered" | "in_progress" | "reported" | "cancelled";

export interface ImagingOrder {
  order_id: string;
  patient_id: string;
  patient_name: string;
  uhid: string;
  visit_id: string | null;
  doctor_id: string;
  doctor_name: string;
  study: string;
  modality: Modality;
  indication: string | null;
  priority: "routine" | "urgent";
  status: ImagingStatus;
  findings: string | null;
  impression: string | null;
  ordered_at: Date;
  started_at: Date | null;
  reported_at: Date | null;
  reported_by_name: string | null;
  allergies: string | null;
}

const SELECT = `
  SELECT o.order_id, o.patient_id, p.full_name AS patient_name, p.uhid, o.visit_id, o.doctor_id, d.full_name AS doctor_name,
         o.study, o.modality, o.indication, o.priority, o.status, o.findings, o.impression, o.ordered_at, o.started_at,
         o.reported_at, ru.full_name AS reported_by_name, p.allergies
    FROM imaging_orders o
    JOIN patients p ON p.patient_id = o.patient_id
    JOIN doctors d ON d.doctor_id = o.doctor_id
    LEFT JOIN staff_users ru ON ru.user_id = o.reported_by`;

/** A doctor orders a study for a patient they are seeing. */
export async function orderStudy(
  actor: Actor,
  input: { visitId: string; study: string; modality?: Modality; indication?: string; priority?: "routine" | "urgent" },
): Promise<{ orderId: string }> {
  need(actor, "imaging.order", "Only a doctor can order imaging.");
  const study = input.study.trim().slice(0, 120);
  if (study.length < 2) throw new ImagingError("validation", "Say which study is needed.");
  const known = STUDY_CATALOGUE.find((s) => s.study.toLowerCase() === study.toLowerCase());
  const modality: Modality = input.modality && input.modality in MODALITIES ? input.modality : (known?.modality ?? "other");

  return tx(async (c) => {
    const visit = await one<{ patient_id: string; doctor_id: string; status: string; correlation_id: string }>(
      c,
      `SELECT patient_id, doctor_id, status, correlation_id FROM visits WHERE visit_id = $1`,
      [input.visitId],
    );
    if (!visit) throw new ImagingError("not_found", "That visit does not exist.");
    if (!actor.doctor_id || actor.doctor_id !== visit.doctor_id) throw new ImagingError("not_your_patient", "This patient is in another doctor's queue.");
    if (visit.status === "cancelled") throw new ImagingError("wrong_state", "This visit was cancelled.");

    const id = newId("IMG");
    await c.query(
      `INSERT INTO imaging_orders (order_id, patient_id, visit_id, doctor_id, ordered_by, study, modality, indication, priority, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, visit.patient_id, input.visitId, visit.doctor_id, actor.user_id, study, modality, input.indication?.trim().slice(0, 300) || null, input.priority ?? "routine", visit.correlation_id],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "imaging.ordered", recordId: id, correlationId: visit.correlation_id, details: { study, priority: input.priority ?? "routine" } });
    return { orderId: id };
  });
}

/** The radiologist or technician starts work on a study. Idempotent for a reloaded page. */
export async function startStudy(actor: Actor, orderId: string): Promise<void> {
  need(actor, "imaging.report", "Only radiology can work on studies.");
  await tx(async (c) => {
    const o = await one<{ status: ImagingStatus; correlation_id: string }>(c, `SELECT status, correlation_id FROM imaging_orders WHERE order_id = $1 FOR UPDATE`, [orderId]);
    if (!o) throw new ImagingError("not_found", "That order does not exist.");
    if (o.status === "in_progress") return;
    if (o.status !== "ordered") throw new ImagingError("wrong_state", `This study is ${o.status}.`);
    await c.query(`UPDATE imaging_orders SET status = 'in_progress', started_at = now(), started_by = $2 WHERE order_id = $1`, [orderId, actor.user_id]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "imaging.started", recordId: orderId, correlationId: o.correlation_id });
  });
}

/** Writes the report. A study can be reported once; corrections are a new order or a note from the doctor. */
export async function submitReport(actor: Actor, orderId: string, input: { findings?: string; impression: string }): Promise<void> {
  need(actor, "imaging.report", "Only radiology can report studies.");
  const impression = input.impression.trim().slice(0, 1500);
  if (impression.length < 3) throw new ImagingError("validation", "Write the impression: what the study shows.");
  const findings = input.findings?.trim().slice(0, 4000) || null;
  await tx(async (c) => {
    const o = await one<{ status: ImagingStatus; correlation_id: string }>(c, `SELECT status, correlation_id FROM imaging_orders WHERE order_id = $1 FOR UPDATE`, [orderId]);
    if (!o) throw new ImagingError("not_found", "That order does not exist.");
    if (o.status === "reported") throw new ImagingError("wrong_state", "This study has already been reported.");
    if (o.status === "cancelled") throw new ImagingError("wrong_state", "This order was cancelled.");
    await c.query(
      `UPDATE imaging_orders
          SET status = 'reported', findings = $2, impression = $3, reported_by = $4, reported_at = now(),
              started_at = COALESCE(started_at, now()), started_by = COALESCE(started_by, $4)
        WHERE order_id = $1`,
      [orderId, findings, impression, actor.user_id],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "imaging.reported", recordId: orderId, correlationId: o.correlation_id });
  });
}

export async function cancelOrder(actor: Actor, orderId: string, reason: string): Promise<void> {
  need(actor, "imaging.order", "Only the ordering doctor can cancel a study.");
  if (reason.trim().length < 3) throw new ImagingError("validation", "Say why it is being cancelled.");
  await tx(async (c) => {
    const o = await one<{ status: ImagingStatus; doctor_id: string; correlation_id: string }>(
      c,
      `SELECT status, doctor_id, correlation_id FROM imaging_orders WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    if (!o) throw new ImagingError("not_found", "That order does not exist.");
    if (o.doctor_id !== actor.doctor_id) throw new ImagingError("not_your_patient", "Only the ordering doctor can cancel this.");
    if (o.status !== "ordered") throw new ImagingError("wrong_state", "Only a study that has not started can be cancelled.");
    await c.query(`UPDATE imaging_orders SET status = 'cancelled' WHERE order_id = $1`, [orderId]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "imaging.cancelled", recordId: orderId, correlationId: o.correlation_id, details: { reason } });
  });
}

/** The radiology worklist: urgent first, then oldest. Reported studies show the last two days. */
export async function worklist(db: Db): Promise<{ open: ImagingOrder[]; reported: ImagingOrder[] }> {
  const open = await many<ImagingOrder>(
    db,
    `${SELECT} WHERE o.status IN ('ordered', 'in_progress')
      ORDER BY (o.priority = 'urgent') DESC, (o.status = 'in_progress') DESC, o.ordered_at`,
  );
  const reported = await many<ImagingOrder>(
    db,
    `${SELECT} WHERE o.status = 'reported' AND o.reported_at > now() - interval '2 days' ORDER BY o.reported_at DESC LIMIT 30`,
  );
  return { open, reported };
}

export async function getOrder(db: Db, orderId: string): Promise<ImagingOrder | null> {
  return (await many<ImagingOrder>(db, `${SELECT} WHERE o.order_id = $1`, [orderId]))[0] ?? null;
}

export async function ordersForVisit(db: Db, visitId: string): Promise<ImagingOrder[]> {
  return many<ImagingOrder>(db, `${SELECT} WHERE o.visit_id = $1 ORDER BY o.ordered_at`, [visitId]);
}

export async function ordersForPatient(db: Db, patientId: string, limit = 10): Promise<ImagingOrder[]> {
  return many<ImagingOrder>(db, `${SELECT} WHERE o.patient_id = $1 AND o.status <> 'cancelled' ORDER BY o.ordered_at DESC LIMIT $2`, [patientId, limit]);
}

export async function imagingCounts(db: Db): Promise<{ ordered: number; in_progress: number; urgent_open: number; reported_today: number }> {
  const r = await one<{ ordered: number; in_progress: number; urgent_open: number; reported_today: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status = 'ordered')::int AS ordered,
            count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
            count(*) FILTER (WHERE status IN ('ordered', 'in_progress') AND priority = 'urgent')::int AS urgent_open,
            count(*) FILTER (WHERE status = 'reported' AND reported_at > now() - interval '1 day')::int AS reported_today
       FROM imaging_orders`,
  );
  return r!;
}
