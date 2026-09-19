import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { raiseException } from "@/lib/exceptions";
import { newId } from "@/lib/ids";
import { cancelQueuedJobs, enqueue } from "@/lib/jobs";
import { formatSlot } from "@/lib/time";
import { sendTemplateMessage } from "@/server/messaging/send";
import { JOB } from "./job-types";

export type Attendance = "pending" | "attended" | "no_show";

interface AppointmentRow {
  appointment_id: string;
  patient_id: string;
  department_id: string;
  doctor_id: string;
  status: string;
  attendance_status: Attendance;
  slot_start: Date;
  slot_end: Date;
  attendance_marked_at: Date | null;
  correlation_id: string;
}

const followUpKey = (appointmentId: string) => `noshow:${appointmentId}`;

/**
 * Records whether a patient attended. The single entry point for both staff clicks
 * and automatic detection, so every downstream effect happens exactly once.
 */
export async function markAttendance(
  appointmentId: string,
  attendance: Attendance,
  markedBy: string,
): Promise<{ changed: boolean; reason?: string }> {
  const e = env();
  return tx(async (c) => {
    const appt = await one<AppointmentRow>(
      c,
      `SELECT appointment_id, patient_id, department_id, doctor_id, status, attendance_status, slot_start, slot_end,
              attendance_marked_at, correlation_id
       FROM appointments WHERE appointment_id = $1 FOR UPDATE`,
      [appointmentId],
    );
    if (!appt) throw new Error(`Appointment ${appointmentId} not found`);
    if (appt.attendance_status === attendance) return { changed: false, reason: "already set" };
    if (appt.status !== "booked") return { changed: false, reason: `appointment is ${appt.status}` };

    await c.query(
      `UPDATE appointments SET attendance_status = $2, attendance_marked_at = now(), attendance_marked_by = $3, updated_at = now()
       WHERE appointment_id = $1`,
      [appointmentId, attendance, markedBy],
    );
    await audit(c, {
      workflow: "noShow",
      actor: markedBy === "system" ? "system" : "staff",
      action: "attendance.marked",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { attendance, previous: appt.attendance_status, marked_by: markedBy },
    });

    if (attendance === "no_show") {
      // The visit is over: pending reminders would be wrong and confusing.
      await cancelQueuedJobs(c, `appointment.reminder:${appointmentId}`);
      await enqueue(c, {
        type: JOB.noShowRecover,
        payload: { appointment_id: appointmentId },
        runAt: new Date(Date.now() + e.NO_SHOW_RECOVERY_DELAY_MINUTES * 60_000),
        dedupeKey: `noshow.recover:${appointmentId}`,
        correlationId: appt.correlation_id,
      });
    } else {
      // Attended (or corrected back): stop any recovery chase that has not run yet.
      await cancelQueuedJobs(c, `noshow.recover:${appointmentId}`);
      await cancelQueuedJobs(c, `noshow.escalate:${appointmentId}`);
      await c.query(
        `UPDATE follow_ups SET status = 'cancelled', updated_at = now() WHERE dedupe_key = $1 AND status = 'open'`,
        [followUpKey(appointmentId)],
      );
    }
    return { changed: true };
  });
}

/**
 * Marks visits that ended more than NO_SHOW_GRACE_MINUTES ago and were never checked in.
 * Hospitals with an HMS that reports attendance should drive markAttendance from that instead.
 */
export async function sweepNoShows(now = new Date()): Promise<string[]> {
  const e = env();
  if (!e.NO_SHOW_AUTO_DETECT) return [];
  const due = await many<{ appointment_id: string }>(
    pool(),
    `SELECT appointment_id FROM appointments
     WHERE status = 'booked' AND attendance_status = 'pending'
       AND slot_end < $1::timestamptz - make_interval(mins => $2)
     ORDER BY slot_end
     LIMIT 100`,
    [now, e.NO_SHOW_GRACE_MINUTES],
  );
  const marked: string[] = [];
  for (const { appointment_id } of due) {
    const r = await markAttendance(appointment_id, "no_show", "system");
    if (r.changed) marked.push(appointment_id);
  }
  return marked;
}

/** Has this patient booked again since the missed visit? That counts as recovered. */
async function rebookedSince(db: Db, patientId: string, missedAppointmentId: string, since: Date | null): Promise<string | null> {
  const row = await one<{ appointment_id: string }>(
    db,
    `SELECT appointment_id FROM appointments
     WHERE patient_id = $1 AND appointment_id <> $2 AND status = 'booked'
       AND created_at >= COALESCE($3::timestamptz, '-infinity')
     ORDER BY created_at DESC LIMIT 1`,
    [patientId, missedAppointmentId, since],
  );
  return row?.appointment_id ?? null;
}

interface RecoveryContext extends AppointmentRow {
  patient_name: string;
  doctor_name: string;
  department_name: string;
}

async function loadContext(appointmentId: string): Promise<RecoveryContext | undefined> {
  return one<RecoveryContext>(
    pool(),
    `SELECT a.appointment_id, a.patient_id, a.department_id, a.doctor_id, a.status, a.attendance_status,
            a.slot_start, a.slot_end, a.attendance_marked_at, a.correlation_id,
            p.full_name AS patient_name, d.full_name AS doctor_name, dep.name AS department_name
     FROM appointments a
     JOIN patients p USING (patient_id)
     JOIN doctors d ON d.doctor_id = a.doctor_id
     JOIN departments dep ON dep.department_id = a.department_id
     WHERE a.appointment_id = $1`,
    [appointmentId],
  );
}

/**
 * Earliest open slot on each of the next few days, to offer as reschedule options.
 * Never offers a time at or before the appointment that was missed.
 */
export async function nextOpenSlots(db: Db, departmentId: string, after: Date, limit = 3): Promise<Date[]> {
  const rows = await many<{ slot_start: Date }>(
    db,
    `SELECT min(slot_start) AS slot_start FROM slots
     WHERE department_id = $1 AND status = 'open'
       AND slot_start > GREATEST(now() + interval '2 hours', $2::timestamptz)
     GROUP BY date_trunc('day', slot_start AT TIME ZONE 'Asia/Kolkata')
     ORDER BY 1 LIMIT $3`,
    [departmentId, after, limit],
  );
  return rows.map((r) => r.slot_start);
}

/**
 * Step 1 of recovery: offer a reschedule and open a task for reception.
 * Runs only if the appointment is still a no-show and the patient has not rebooked.
 */
export async function recoverNoShow(appointmentId: string): Promise<void> {
  const e = env();
  const appt = await loadContext(appointmentId);
  if (!appt) throw new Error(`Appointment ${appointmentId} not found`);

  const skip = (reason: string) =>
    audit(pool(), {
      workflow: "noShow",
      actor: "system",
      action: "noshow.recovery_skipped",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { reason },
    });

  if (appt.attendance_status !== "no_show") return skip(`attendance is now ${appt.attendance_status}`);
  if (appt.status !== "booked") return skip(`appointment is ${appt.status}`);

  const rebooked = await rebookedSince(pool(), appt.patient_id, appointmentId, appt.attendance_marked_at);
  if (rebooked) return skip(`patient already rebooked (${rebooked})`);

  const slots = await nextOpenSlots(pool(), appt.department_id, appt.slot_start);
  const options = slots.length ? slots.map(formatSlot).join(" | ") : "please call us for the next available time";

  // Open the reception task first: if messaging fails, a person still owns the patient.
  await tx(async (c) => {
    await c.query(
      `INSERT INTO follow_ups (followup_id, patient_id, appointment_id, category, owner, status, attempt_count,
                               next_action_at, notes, dedupe_key, correlation_id)
       VALUES ($1, $2, $3, 'no_show_recovery', 'front_desk', 'open', 1, now() + make_interval(hours => $4), $5, $6, $7)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        newId("FUP"),
        appt.patient_id,
        appointmentId,
        e.NO_SHOW_FOLLOWUP_HOURS,
        `Missed ${appt.department_name} appointment with ${appt.doctor_name} on ${formatSlot(appt.slot_start)}.`,
        followUpKey(appointmentId),
        appt.correlation_id,
      ],
    );
    await enqueue(c, {
      type: JOB.noShowEscalate,
      payload: { appointment_id: appointmentId, attempt: 1 },
      runAt: new Date(Date.now() + e.NO_SHOW_FOLLOWUP_HOURS * 3600_000),
      dedupeKey: `noshow.escalate:${appointmentId}:1`,
      correlationId: appt.correlation_id,
    });
    await audit(c, {
      workflow: "noShow",
      actor: "system",
      action: "noshow.recovery_started",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { options_offered: slots.length },
    });
  });

  await sendTemplateMessage({
    dedupeKey: `msg:${appointmentId}:NOSHOW_RECOVERY_01`,
    patientId: appt.patient_id,
    template: "NOSHOW_RECOVERY_01",
    workflow: "noShow",
    correlationId: appt.correlation_id,
    vars: {
      patient_name: appt.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      doctor_name: appt.doctor_name,
      missed_slot: formatSlot(appt.slot_start),
      options,
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
}

interface FollowUpRow {
  followup_id: string;
  patient_id: string;
  status: string;
  attempt_count: number;
}

/**
 * Step 2: after the wait window, either close the loop (patient rebooked),
 * try once more, or hand the patient to reception to call.
 */
export async function escalateNoShow(appointmentId: string, attempt: number): Promise<void> {
  const e = env();
  const appt = await loadContext(appointmentId);
  if (!appt) throw new Error(`Appointment ${appointmentId} not found`);

  const followUp = await one<FollowUpRow>(
    pool(),
    `SELECT followup_id, patient_id, status, attempt_count FROM follow_ups WHERE dedupe_key = $1`,
    [followUpKey(appointmentId)],
  );
  if (!followUp || followUp.status !== "open") return;

  const rebooked = await rebookedSince(pool(), appt.patient_id, appointmentId, appt.attendance_marked_at);
  if (rebooked) {
    await tx(async (c) => {
      await c.query(
        `UPDATE follow_ups SET status = 'done', notes = COALESCE(notes, '') || ' Recovered: patient rebooked.', updated_at = now()
         WHERE followup_id = $1 AND status = 'open'`,
        [followUp.followup_id],
      );
      await audit(c, {
        workflow: "noShow",
        actor: "system",
        action: "noshow.recovered",
        recordId: appointmentId,
        correlationId: appt.correlation_id,
        details: { new_appointment_id: rebooked, attempts: followUp.attempt_count },
      });
    });
    return;
  }

  if (attempt < e.NO_SHOW_MAX_ATTEMPTS) {
    await tx(async (c) => {
      await c.query(
        `UPDATE follow_ups SET attempt_count = $2, next_action_at = now() + make_interval(hours => $3), updated_at = now()
         WHERE followup_id = $1`,
        [followUp.followup_id, attempt + 1, e.NO_SHOW_FOLLOWUP_HOURS],
      );
      await enqueue(c, {
        type: JOB.noShowEscalate,
        payload: { appointment_id: appointmentId, attempt: attempt + 1 },
        runAt: new Date(Date.now() + e.NO_SHOW_FOLLOWUP_HOURS * 3600_000),
        dedupeKey: `noshow.escalate:${appointmentId}:${attempt + 1}`,
        correlationId: appt.correlation_id,
      });
    });
    await sendTemplateMessage({
      dedupeKey: `msg:${appointmentId}:NOSHOW_FOLLOWUP_02:${attempt + 1}`,
      patientId: appt.patient_id,
      template: "NOSHOW_FOLLOWUP_02",
      workflow: "noShow",
      correlationId: appt.correlation_id,
      vars: { patient_name: appt.patient_name, hospital_name: e.HOSPITAL_NAME, hospital_contact: e.HOSPITAL_CONTACT },
    });
    return;
  }

  // Out of automated attempts: a person takes over. The task stays open until they close it.
  await tx(async (c) => {
    await c.query(`UPDATE follow_ups SET next_action_at = now(), updated_at = now() WHERE followup_id = $1`, [followUp.followup_id]);
    await raiseException(c, {
      workflow: "noShow",
      errorType: "NO_SHOW_UNRESPONSIVE",
      severity: "medium",
      summary: `${appt.patient_name} missed their ${appt.department_name} appointment and has not responded after ${attempt} message(s). Please call.`,
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      owner: "front_desk",
      details: { missed_slot: appt.slot_start, doctor: appt.doctor_name, attempts: attempt },
      dedupeKey: `noshow-unresponsive:${appointmentId}`,
    });
    await audit(c, {
      workflow: "noShow",
      actor: "system",
      action: "noshow.escalated_to_staff",
      recordId: appointmentId,
      correlationId: appt.correlation_id,
      details: { attempts: attempt },
    });
  });
}

/** Staff closing a follow-up by hand (patient called back, not interested, etc.). */
export async function closeFollowUp(followupId: string, outcome: "done" | "cancelled", note: string): Promise<boolean> {
  return tx(async (c) => {
    const r = await c.query<{ correlation_id: string | null; appointment_id: string | null }>(
      `UPDATE follow_ups SET status = $2, notes = COALESCE(notes, '') || ' ' || $3, updated_at = now()
       WHERE followup_id = $1 AND status = 'open'
       RETURNING correlation_id, appointment_id`,
      [followupId, outcome, note],
    );
    const row = r.rows[0];
    if (!row) return false;
    await audit(c, {
      workflow: "noShow",
      actor: "staff",
      action: outcome === "done" ? "followup.closed" : "followup.cancelled",
      recordId: row.appointment_id ?? followupId,
      correlationId: row.correlation_id,
      details: { note },
    });
    return true;
  });
}
