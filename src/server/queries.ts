import { many, one, pool } from "@/lib/db";
import { istDateString, istDayRange } from "@/lib/time";

export interface DashboardStats {
  leads_today: number;
  booked_today: number;
  needs_review_open: number;
  no_slot_open: number;
  exceptions_open: number;
  exceptions_high: number;
  messages_today: number;
  messages_failed_today: number;
  avg_first_response_seconds: number | null;
  upcoming_appointments: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [start, end] = istDayRange(istDateString());
  return (await one<DashboardStats>(
    pool(),
    `SELECT
       (SELECT count(*) FROM leads WHERE created_at >= $1 AND created_at < $2)::int AS leads_today,
       (SELECT count(*) FROM appointments WHERE created_at >= $1 AND created_at < $2)::int AS booked_today,
       (SELECT count(*) FROM leads WHERE status = 'needs_review')::int AS needs_review_open,
       (SELECT count(*) FROM leads WHERE status = 'no_slot')::int AS no_slot_open,
       (SELECT count(*) FROM exceptions WHERE status = 'open')::int AS exceptions_open,
       (SELECT count(*) FROM exceptions WHERE status = 'open' AND severity = 'high')::int AS exceptions_high,
       (SELECT count(*) FROM communication_log WHERE created_at >= $1 AND created_at < $2 AND delivery_status IN ('sent','delivered','read'))::int AS messages_today,
       (SELECT count(*) FROM communication_log WHERE created_at >= $1 AND created_at < $2 AND delivery_status = 'failed')::int AS messages_failed_today,
       (SELECT round(avg(EXTRACT(EPOCH FROM first_response_at - created_at)))::int
          FROM leads WHERE created_at >= $1 AND created_at < $2 AND first_response_at IS NOT NULL) AS avg_first_response_seconds,
       (SELECT count(*) FROM appointments WHERE status = 'booked' AND slot_start > now())::int AS upcoming_appointments`,
    [start, end],
  ))!;
}

export interface LeadListRow {
  lead_id: string;
  correlation_id: string;
  full_name: string;
  phone: string;
  source: string;
  department: string | null;
  department_requested: string | null;
  enquiry_type: string | null;
  status: string;
  priority: string;
  created_at: Date;
  first_response_at: Date | null;
  slot_start: Date | null;
}

export async function listLeads(opts: { status?: string; limit?: number } = {}): Promise<LeadListRow[]> {
  return many<LeadListRow>(
    pool(),
    `SELECT l.lead_id, l.correlation_id, p.full_name, p.phone, l.source, dep.name AS department, l.department_requested,
            l.enquiry_type, l.status, l.priority, l.created_at, l.first_response_at, a.slot_start
     FROM leads l
     JOIN patients p USING (patient_id)
     LEFT JOIN departments dep ON dep.department_id = l.department
     LEFT JOIN appointments a ON a.appointment_id = l.appointment_id
     WHERE $1::text IS NULL OR l.status = $1
     ORDER BY l.created_at DESC
     LIMIT $2`,
    [opts.status ?? null, opts.limit ?? 50],
  );
}

export interface LeadDetail extends LeadListRow {
  patient_id: string;
  email: string | null;
  consent_status: string;
  enquiry_text: string;
  preferred_date: string | null;
  patient_status: string | null;
  ai_result: Record<string, unknown> | null;
  appointment_id: string | null;
  doctor_name: string | null;
}

export async function getLead(leadId: string): Promise<LeadDetail | undefined> {
  return one<LeadDetail>(
    pool(),
    `SELECT l.*, p.full_name, p.phone, p.email, p.consent_status, dep.name AS department,
            a.slot_start, d.full_name AS doctor_name
     FROM leads l
     JOIN patients p USING (patient_id)
     LEFT JOIN departments dep ON dep.department_id = l.department
     LEFT JOIN appointments a ON a.appointment_id = l.appointment_id
     LEFT JOIN doctors d ON d.doctor_id = a.doctor_id
     WHERE l.lead_id = $1`,
    [leadId],
  );
}

export interface TimelineEvent {
  event_id: number;
  timestamp: Date;
  workflow_name: string;
  actor_type: string;
  action: string;
  record_id: string | null;
  details: Record<string, unknown> | null;
}

export async function getTimeline(correlationId: string): Promise<TimelineEvent[]> {
  return many<TimelineEvent>(
    pool(),
    `SELECT event_id, timestamp, workflow_name, actor_type, action, record_id, details
     FROM audit_log WHERE correlation_id = $1 ORDER BY event_id`,
    [correlationId],
  );
}

export interface MessageRow {
  message_id: string;
  recipient: string;
  template_name: string;
  workflow_name: string;
  body: string;
  delivery_status: string;
  skip_reason: string | null;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
  full_name: string | null;
  correlation_id: string | null;
}

export async function listMessages(opts: { correlationId?: string; limit?: number } = {}): Promise<MessageRow[]> {
  return many<MessageRow>(
    pool(),
    `SELECT m.message_id, m.recipient, m.template_name, m.workflow_name, m.body, m.delivery_status, m.skip_reason,
            m.error, m.created_at, m.sent_at, p.full_name, m.correlation_id
     FROM communication_log m LEFT JOIN patients p USING (patient_id)
     WHERE $1::text IS NULL OR m.correlation_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [opts.correlationId ?? null, opts.limit ?? 200],
  );
}

export interface ExceptionRow {
  exception_id: string;
  workflow_name: string;
  record_id: string | null;
  error_type: string;
  severity: "low" | "medium" | "high";
  owner: string | null;
  due_at: Date | null;
  status: string;
  summary: string;
  details: Record<string, unknown> | null;
  resolution_note: string | null;
  correlation_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
  lead_id: string | null;
}

export async function listExceptions(status: "open" | "resolved"): Promise<ExceptionRow[]> {
  return many<ExceptionRow>(
    pool(),
    `SELECT e.*, l.lead_id
     FROM exceptions e LEFT JOIN leads l ON l.correlation_id = e.correlation_id
     WHERE e.status = $1
     ORDER BY CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.created_at DESC
     LIMIT 200`,
    [status],
  );
}

export interface AppointmentRow {
  appointment_id: string;
  patient_name: string;
  phone: string;
  department: string;
  doctor_name: string;
  slot_start: Date;
  status: string;
  attendance_status: string;
  reminder_24h_at: Date | null;
  reminder_3h_at: Date | null;
  lead_id: string | null;
}

export async function listAppointments(): Promise<AppointmentRow[]> {
  return many<AppointmentRow>(
    pool(),
    `SELECT a.appointment_id, p.full_name AS patient_name, p.phone, dep.name AS department, d.full_name AS doctor_name,
            a.slot_start, a.status, a.attendance_status, a.reminder_24h_at, a.reminder_3h_at, a.lead_id
     FROM appointments a
     JOIN patients p USING (patient_id)
     JOIN doctors d ON d.doctor_id = a.doctor_id
     JOIN departments dep ON dep.department_id = a.department_id
     ORDER BY a.slot_start
     LIMIT 200`,
  );
}

export async function listDepartments() {
  return many<{ department_id: string; name: string }>(pool(), `SELECT department_id, name FROM departments WHERE active ORDER BY name`);
}

export interface SystemHealth {
  database: boolean;
  worker_last_seen: Date | null;
  worker_online: boolean;
  jobs_queued: number;
  jobs_dead: number;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  try {
    const r = (await one<{ last_seen: Date | null; queued: number; dead: number }>(
      pool(),
      `SELECT (SELECT max(last_seen) FROM worker_heartbeats) AS last_seen,
              (SELECT count(*) FROM jobs WHERE status = 'queued' AND run_at <= now())::int AS queued,
              (SELECT count(*) FROM jobs WHERE status = 'dead')::int AS dead`,
    ))!;
    const online = !!r.last_seen && Date.now() - new Date(r.last_seen).getTime() < 30_000;
    return { database: true, worker_last_seen: r.last_seen, worker_online: online, jobs_queued: r.queued, jobs_dead: r.dead };
  } catch {
    return { database: false, worker_last_seen: null, worker_online: false, jobs_queued: 0, jobs_dead: 0 };
  }
}

export interface FollowUpRow {
  followup_id: string;
  patient_name: string;
  phone: string;
  category: string;
  status: string;
  owner: string | null;
  attempt_count: number;
  next_action_at: Date | null;
  notes: string | null;
  created_at: Date;
  appointment_id: string | null;
  lead_id: string | null;
  missed_slot: Date | null;
}

export async function listFollowUps(status: "open" | "closed"): Promise<FollowUpRow[]> {
  return many<FollowUpRow>(
    pool(),
    `SELECT f.followup_id, p.full_name AS patient_name, p.phone, f.category, f.status, f.owner, f.attempt_count,
            f.next_action_at, f.notes, f.created_at, f.appointment_id, a.lead_id, a.slot_start AS missed_slot
     FROM follow_ups f
     JOIN patients p USING (patient_id)
     LEFT JOIN appointments a ON a.appointment_id = f.appointment_id
     WHERE ($1 = 'open' AND f.status = 'open') OR ($1 = 'closed' AND f.status <> 'open')
     ORDER BY f.next_action_at NULLS LAST, f.created_at DESC
     LIMIT 200`,
    [status],
  );
}

export interface NoShowStats {
  no_shows_7d: number;
  recovered_7d: number;
  recovery_open: number;
  attended_7d: number;
  no_show_rate_7d: number | null;
}

/** Recovery KPI from the blueprint: recovered appointments / eligible no-shows. */
export async function getNoShowStats(): Promise<NoShowStats> {
  const r = (await one<NoShowStats>(
    pool(),
    `SELECT
       (SELECT count(*) FROM appointments
         WHERE attendance_status = 'no_show' AND attendance_marked_at > now() - interval '7 days')::int AS no_shows_7d,
       (SELECT count(*) FROM follow_ups
         WHERE category = 'no_show_recovery' AND status = 'done' AND updated_at > now() - interval '7 days')::int AS recovered_7d,
       (SELECT count(*) FROM follow_ups WHERE category = 'no_show_recovery' AND status = 'open')::int AS recovery_open,
       (SELECT count(*) FROM appointments
         WHERE attendance_status = 'attended' AND attendance_marked_at > now() - interval '7 days')::int AS attended_7d,
       NULL::numeric AS no_show_rate_7d`,
  ))!;
  const seen = r.no_shows_7d + r.attended_7d;
  return { ...r, no_show_rate_7d: seen > 0 ? Math.round((r.no_shows_7d / seen) * 100) : null };
}
