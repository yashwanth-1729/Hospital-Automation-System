import { audit } from "@/lib/audit";
import { one, pool } from "@/lib/db";
import { env } from "@/lib/env";
import { formatSlot } from "@/lib/time";
import { sendTemplateMessage } from "@/server/messaging/send";

interface AppointmentDetails {
  appointment_id: string;
  patient_id: string;
  lead_id: string | null;
  patient_name: string;
  department_name: string;
  doctor_name: string;
  slot_start: Date;
  status: string;
  attendance_status: string;
  correlation_id: string;
}

export async function loadAppointment(appointmentId: string): Promise<AppointmentDetails | undefined> {
  return one<AppointmentDetails>(
    pool(),
    `SELECT a.appointment_id, a.patient_id, a.lead_id, p.full_name AS patient_name, dep.name AS department_name,
            d.full_name AS doctor_name, a.slot_start, a.status, a.attendance_status, a.correlation_id
     FROM appointments a
     JOIN patients p USING (patient_id)
     JOIN doctors d ON d.doctor_id = a.doctor_id
     JOIN departments dep ON dep.department_id = a.department_id
     WHERE a.appointment_id = $1`,
    [appointmentId],
  );
}

/** Sends the booking confirmation. Details are read at send time, so they are never stale. */
export async function sendAppointmentConfirmation(appointmentId: string): Promise<void> {
  const appt = await loadAppointment(appointmentId);
  if (!appt) throw new Error(`Appointment ${appointmentId} not found`);
  if (appt.status !== "booked") return; // Cancelled before we got to it.

  const e = env();
  await sendTemplateMessage({
    dedupeKey: `msg:${appt.appointment_id}:APPT_CONFIRM_01`,
    patientId: appt.patient_id,
    template: "APPT_CONFIRM_01",
    workflow: "appointment",
    correlationId: appt.correlation_id,
    leadId: appt.lead_id,
    vars: {
      patient_name: appt.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      department: appt.department_name,
      doctor_name: appt.doctor_name,
      slot: formatSlot(appt.slot_start),
      appointment_id: appt.appointment_id,
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
}

/**
 * Sends a reminder only if the appointment is still booked, not yet attended,
 * and still at the time the reminder was scheduled for.
 */
export async function sendAppointmentReminder(appointmentId: string, stage: string, scheduledSlotStart: string): Promise<void> {
  const appt = await loadAppointment(appointmentId);
  if (!appt) throw new Error(`Appointment ${appointmentId} not found`);

  const db = pool();
  const skip = async (reason: string) =>
    audit(db, {
      workflow: "appointment",
      actor: "system",
      action: "reminder.skipped",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { stage, reason },
    });

  if (appt.status !== "booked") return skip(`appointment status is ${appt.status}`);
  if (appt.attendance_status !== "pending") return skip(`attendance is ${appt.attendance_status}`);
  if (appt.slot_start.toISOString() !== scheduledSlotStart) return skip("appointment was rescheduled");
  if (appt.slot_start.getTime() <= Date.now()) return skip("appointment time has passed");

  const e = env();
  const outcome = await sendTemplateMessage({
    dedupeKey: `msg:${appt.appointment_id}:APPT_REMINDER_01:${stage}:${scheduledSlotStart}`,
    patientId: appt.patient_id,
    template: "APPT_REMINDER_01",
    workflow: "appointment",
    correlationId: appt.correlation_id,
    vars: {
      patient_name: appt.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      doctor_name: appt.doctor_name,
      slot: formatSlot(appt.slot_start),
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
  if (outcome.status === "sent") {
    const column = stage === "24h" ? "reminder_24h_at" : "reminder_3h_at";
    await db.query(`UPDATE appointments SET ${column} = now(), updated_at = now() WHERE appointment_id = $1`, [appointmentId]);
  }
}
