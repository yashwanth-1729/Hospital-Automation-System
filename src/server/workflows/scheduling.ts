import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveException } from "@/lib/exceptions";
import { newId } from "@/lib/ids";
import { cancelQueuedJobs, enqueue } from "@/lib/jobs";
import { formatSlot } from "@/lib/time";
import { JOB } from "./job-types";
import { scheduleReminders } from "./lead-intake";

export interface OpenSlot {
  slot_id: string;
  doctor_id: string;
  doctor_name: string;
  department_id: string;
  slot_start: Date;
}

/** Open slots a staff member can pick from, soonest first. */
export async function listOpenSlots(departmentId: string, limit = 20): Promise<OpenSlot[]> {
  return many<OpenSlot>(
    pool(),
    `SELECT s.slot_id, s.doctor_id, d.full_name AS doctor_name, s.department_id, s.slot_start
     FROM slots s JOIN doctors d USING (doctor_id)
     WHERE s.department_id = $1 AND s.status = 'open' AND d.active AND s.slot_start > now() + interval '30 minutes'
     ORDER BY s.slot_start
     LIMIT $2`,
    [departmentId, limit],
  );
}

interface ApptRow {
  appointment_id: string;
  patient_id: string;
  patient_name: string;
  lead_id: string | null;
  department_id: string;
  department_name: string;
  doctor_name: string;
  slot_id: string;
  slot_start: Date;
  status: string;
  attendance_status: string;
  correlation_id: string;
}

const LOAD_APPT = `
  SELECT a.appointment_id, a.patient_id, p.full_name AS patient_name, a.lead_id, a.department_id,
         dep.name AS department_name, d.full_name AS doctor_name, a.slot_id, a.slot_start, a.status,
         a.attendance_status, a.correlation_id
  FROM appointments a
  JOIN patients p USING (patient_id)
  JOIN doctors d ON d.doctor_id = a.doctor_id
  JOIN departments dep ON dep.department_id = a.department_id
  WHERE a.appointment_id = $1 FOR UPDATE OF a`;

export type SchedulingResult = { ok: true } | { ok: false; reason: string };

/** Cancels an appointment, frees the slot, stops reminders and tells the patient. */
export async function cancelAppointment(appointmentId: string, reason: string, actor: string): Promise<SchedulingResult> {
  const e = env();
  return tx(async (c) => {
    const appt = await one<ApptRow>(c, LOAD_APPT, [appointmentId]);
    if (!appt) return { ok: false, reason: "Appointment not found" };
    if (appt.status !== "booked") return { ok: false, reason: `Appointment is already ${appt.status}` };

    await c.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3, updated_at = now()
       WHERE appointment_id = $1`,
      [appointmentId, reason.slice(0, 500) || null, actor],
    );
    await c.query(`UPDATE slots SET status = 'open', appointment_id = NULL WHERE slot_id = $1`, [appt.slot_id]);
    await cancelQueuedJobs(c, `appointment.reminder:${appointmentId}`);
    await cancelQueuedJobs(c, `noshow.recover:${appointmentId}`);
    await cancelQueuedJobs(c, `noshow.escalate:${appointmentId}`);
    if (appt.lead_id) {
      await c.query(`UPDATE leads SET status = 'closed', updated_at = now() WHERE lead_id = $1 AND status = 'booked'`, [appt.lead_id]);
    }
    await audit(c, {
      workflow: "appointment",
      actor: actor === "system" ? "system" : "staff",
      action: "appointment.cancelled",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { reason, slot_start: appt.slot_start, freed_slot: appt.slot_id },
    });
    await enqueue(c, {
      type: JOB.messageSend,
      payload: {
        dedupe_key: `msg:${appointmentId}:APPT_CANCELLED_01`,
        patient_id: appt.patient_id,
        template: "APPT_CANCELLED_01",
        workflow: "appointment",
        vars: {
          patient_name: appt.patient_name,
          hospital_name: e.HOSPITAL_NAME,
          slot: formatSlot(appt.slot_start),
          hospital_contact: e.HOSPITAL_CONTACT,
        },
      },
      dedupeKey: `job:msg:${appointmentId}:APPT_CANCELLED_01`,
      correlationId: appt.correlation_id,
    });
    return { ok: true };
  });
}

/** Moves an appointment to another open slot in the same department. */
export async function rescheduleAppointment(appointmentId: string, newSlotId: string, actor: string): Promise<SchedulingResult> {
  const e = env();
  return tx(async (c) => {
    const appt = await one<ApptRow>(c, LOAD_APPT, [appointmentId]);
    if (!appt) return { ok: false, reason: "Appointment not found" };
    if (appt.status !== "booked") return { ok: false, reason: `Appointment is ${appt.status}` };

    const slot = await one<{ slot_id: string; doctor_id: string; department_id: string; slot_start: Date; slot_end: Date; status: string }>(
      c,
      `SELECT slot_id, doctor_id, department_id, slot_start, slot_end, status FROM slots WHERE slot_id = $1 FOR UPDATE`,
      [newSlotId],
    );
    if (!slot) return { ok: false, reason: "Slot not found" };
    if (slot.status !== "open") return { ok: false, reason: "That slot was just taken" };
    if (slot.department_id !== appt.department_id) return { ok: false, reason: "Slot belongs to a different department" };
    if (slot.slot_start.getTime() <= Date.now()) return { ok: false, reason: "That slot is in the past" };

    await c.query(`UPDATE slots SET status = 'open', appointment_id = NULL WHERE slot_id = $1`, [appt.slot_id]);
    await c.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE slot_id = $1`, [newSlotId, appointmentId]);
    await c.query(
      `UPDATE appointments SET slot_id = $2, doctor_id = $3, slot_start = $4, slot_end = $5,
                               reminder_24h_at = NULL, reminder_3h_at = NULL,
                               reschedule_count = reschedule_count + 1, updated_at = now()
       WHERE appointment_id = $1`,
      [appointmentId, newSlotId, slot.doctor_id, slot.slot_start, slot.slot_end],
    );

    // Old reminders referenced the old time; new ones are keyed by the new slot start.
    await cancelQueuedJobs(c, `appointment.reminder:${appointmentId}`);
    await scheduleReminders(c, appointmentId, slot.slot_start, appt.correlation_id);

    const doctor = await one<{ full_name: string }>(c, `SELECT full_name FROM doctors WHERE doctor_id = $1`, [slot.doctor_id]);
    await audit(c, {
      workflow: "appointment",
      actor: actor === "system" ? "system" : "staff",
      action: "appointment.rescheduled",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { from: appt.slot_start, to: slot.slot_start, doctor_id: slot.doctor_id },
    });
    await enqueue(c, {
      type: JOB.messageSend,
      payload: {
        dedupe_key: `msg:${appointmentId}:APPT_RESCHEDULED_01:${slot.slot_start.toISOString()}`,
        patient_id: appt.patient_id,
        template: "APPT_RESCHEDULED_01",
        workflow: "appointment",
        vars: {
          patient_name: appt.patient_name,
          hospital_name: e.HOSPITAL_NAME,
          department: appt.department_name,
          doctor_name: doctor?.full_name ?? appt.doctor_name,
          slot: formatSlot(slot.slot_start),
          hospital_contact: e.HOSPITAL_CONTACT,
        },
      },
      dedupeKey: `job:msg:${appointmentId}:APPT_RESCHEDULED_01:${slot.slot_start.toISOString()}`,
      correlationId: appt.correlation_id,
    });
    return { ok: true };
  });
}

/**
 * Books a lead that the automation sent to a human (review or no slot).
 * Resolves the matching exception so the queue stays honest.
 */
export async function bookLeadManually(leadId: string, slotId: string, actor: string): Promise<SchedulingResult> {
  return tx(async (c) => {
    const lead = await one<{ lead_id: string; patient_id: string; status: string; correlation_id: string }>(
      c,
      `SELECT lead_id, patient_id, status, correlation_id FROM leads WHERE lead_id = $1 FOR UPDATE`,
      [leadId],
    );
    if (!lead) return { ok: false, reason: "Lead not found" };
    if (lead.status === "booked") return { ok: false, reason: "This lead already has an appointment" };
    if (lead.status === "new") return { ok: false, reason: "This enquiry is still being processed" };

    const slot = await one<{ slot_id: string; doctor_id: string; department_id: string; slot_start: Date; slot_end: Date; status: string }>(
      c,
      `SELECT slot_id, doctor_id, department_id, slot_start, slot_end, status FROM slots WHERE slot_id = $1 FOR UPDATE`,
      [slotId],
    );
    if (!slot) return { ok: false, reason: "Slot not found" };
    if (slot.status !== "open") return { ok: false, reason: "That slot was just taken" };
    if (slot.slot_start.getTime() <= Date.now()) return { ok: false, reason: "That slot is in the past" };

    const appointmentId = newId("APT");
    await c.query(
      `INSERT INTO appointments (appointment_id, patient_id, lead_id, department_id, doctor_id, slot_id,
                                 slot_start, slot_end, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [appointmentId, lead.patient_id, leadId, slot.department_id, slot.doctor_id, slotId, slot.slot_start, slot.slot_end, lead.correlation_id],
    );
    await c.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE slot_id = $1`, [slotId, appointmentId]);
    await c.query(
      `UPDATE leads SET status = 'booked', department = COALESCE(department, $3), appointment_id = $2, updated_at = now()
       WHERE lead_id = $1`,
      [leadId, appointmentId, slot.department_id],
    );

    const open = await many<{ exception_id: string }>(
      c,
      `SELECT exception_id FROM exceptions WHERE record_id = $1 AND status = 'open'`,
      [leadId],
    );
    for (const { exception_id } of open) {
      await resolveException(c, exception_id, `Booked by ${actor} for ${formatSlot(slot.slot_start)}`);
    }

    await audit(c, {
      workflow: "appointment",
      actor: "staff",
      action: "appointment.booked_by_staff",
      recordId: appointmentId,
      correlationId: lead.correlation_id,
      details: { lead_id: leadId, slot_start: slot.slot_start, resolved_exceptions: open.length },
    });
    await enqueue(c, {
      type: JOB.appointmentConfirm,
      payload: { appointment_id: appointmentId },
      dedupeKey: `appointment.confirm:${appointmentId}`,
      correlationId: lead.correlation_id,
    });
    await scheduleReminders(c, appointmentId, slot.slot_start, lead.correlation_id);
    return { ok: true };
  });
}

/** Slots for a department, used by the staff booking UI. */
export async function openSlotsFor(db: Db, departmentId: string | null, limit = 20): Promise<OpenSlot[]> {
  if (!departmentId) return [];
  return listOpenSlots(departmentId, limit);
}
