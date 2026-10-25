import { many, one, pool } from "@/lib/db";
import { istDateString, istDayRange } from "@/lib/time";
import { careStats, type CareStats } from "@/server/care/care";
import { labStats, type LabStats } from "@/server/care/labs";

export interface Funnel {
  enquiries: number;
  auto_booked: number;
  staff_booked: number;
  needs_review: number;
  no_slot: number;
  attended: number;
  no_shows: number;
  cancelled: number;
  conversion_rate: number | null;
  automation_rate: number | null;
}

/** Window helper: [start, end) covering the last `days` IST days including today. */
function windowFor(days: number): [Date, Date] {
  const [, end] = istDayRange(istDateString());
  return [new Date(end.getTime() - days * 86400000), end];
}

export async function getFunnel(days: number): Promise<Funnel> {
  const [start, end] = windowFor(days);
  const r = (await one<Omit<Funnel, "conversion_rate" | "automation_rate">>(
    pool(),
    `SELECT
       (SELECT count(*) FROM leads WHERE created_at >= $1 AND created_at < $2)::int AS enquiries,
       (SELECT count(*) FROM appointments a JOIN audit_log al ON al.record_id = a.appointment_id
          AND al.action = 'appointment.booked'
        WHERE a.created_at >= $1 AND a.created_at < $2)::int AS auto_booked,
       (SELECT count(*) FROM appointments a JOIN audit_log al ON al.record_id = a.appointment_id
          AND al.action = 'appointment.booked_by_staff'
        WHERE a.created_at >= $1 AND a.created_at < $2)::int AS staff_booked,
       (SELECT count(*) FROM leads WHERE created_at >= $1 AND created_at < $2 AND status = 'needs_review')::int AS needs_review,
       (SELECT count(*) FROM leads WHERE created_at >= $1 AND created_at < $2 AND status = 'no_slot')::int AS no_slot,
       (SELECT count(*) FROM appointments WHERE attendance_marked_at >= $1 AND attendance_marked_at < $2
          AND attendance_status = 'attended')::int AS attended,
       (SELECT count(*) FROM appointments WHERE attendance_marked_at >= $1 AND attendance_marked_at < $2
          AND attendance_status = 'no_show')::int AS no_shows,
       (SELECT count(*) FROM appointments WHERE cancelled_at >= $1 AND cancelled_at < $2)::int AS cancelled`,
    [start, end],
  ))!;
  const booked = r.auto_booked + r.staff_booked;
  return {
    ...r,
    conversion_rate: r.enquiries ? Math.round((booked / r.enquiries) * 100) : null,
    automation_rate: booked ? Math.round((r.auto_booked / booked) * 100) : null,
  };
}

export interface ResponseTimes {
  average_seconds: number | null;
  median_seconds: number | null;
  under_five_minutes: number | null;
}

export async function getResponseTimes(days: number): Promise<ResponseTimes> {
  const [start, end] = windowFor(days);
  const r = (await one<{ average_seconds: number | null; median_seconds: number | null; pct: number | null }>(
    pool(),
    `SELECT round(avg(EXTRACT(EPOCH FROM first_response_at - created_at)))::int AS average_seconds,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM first_response_at - created_at)))::int AS median_seconds,
            round(100.0 * count(*) FILTER (WHERE first_response_at - created_at < interval '5 minutes') / NULLIF(count(*), 0))::int AS pct
     FROM leads
     WHERE created_at >= $1 AND created_at < $2 AND first_response_at IS NOT NULL`,
    [start, end],
  ))!;
  return { average_seconds: r.average_seconds, median_seconds: r.median_seconds, under_five_minutes: r.pct };
}

export interface DepartmentPerformance {
  department: string;
  leads: number;
  booked: number;
  no_shows: number;
  recovered: number;
  avg_rating: number | null;
}

export async function getDepartmentPerformance(days: number): Promise<DepartmentPerformance[]> {
  const [start, end] = windowFor(days);
  return many<DepartmentPerformance>(
    pool(),
    `SELECT dep.name AS department,
            (SELECT count(*) FROM leads l WHERE l.department = dep.department_id AND l.created_at >= $1 AND l.created_at < $2)::int AS leads,
            (SELECT count(*) FROM appointments a WHERE a.department_id = dep.department_id AND a.created_at >= $1 AND a.created_at < $2)::int AS booked,
            (SELECT count(*) FROM appointments a WHERE a.department_id = dep.department_id
               AND a.attendance_status = 'no_show' AND a.attendance_marked_at >= $1 AND a.attendance_marked_at < $2)::int AS no_shows,
            (SELECT count(*) FROM follow_ups f JOIN appointments a ON a.appointment_id = f.appointment_id
               WHERE a.department_id = dep.department_id AND f.category = 'no_show_recovery' AND f.status = 'done'
               AND f.updated_at >= $1 AND f.updated_at < $2)::int AS recovered,
            (SELECT round(avg(fb.rating), 1) FROM feedback fb JOIN discharges d ON d.discharge_id = fb.discharge_id
               WHERE d.department_id = dep.department_id AND fb.created_at >= $1 AND fb.created_at < $2) AS avg_rating
     FROM departments dep
     WHERE dep.active
     ORDER BY leads DESC, dep.name`,
    [start, end],
  ).then((rows) => rows.map((r) => ({ ...r, avg_rating: r.avg_rating === null ? null : Number(r.avg_rating) })));
}

export interface SourcePerformance {
  source: string;
  leads: number;
  booked: number;
  conversion_rate: number | null;
}

export async function getSourcePerformance(days: number): Promise<SourcePerformance[]> {
  const [start, end] = windowFor(days);
  const rows = await many<{ source: string; leads: number; booked: number }>(
    pool(),
    `SELECT l.source,
            count(*)::int AS leads,
            count(*) FILTER (WHERE l.appointment_id IS NOT NULL)::int AS booked
     FROM leads l
     WHERE l.created_at >= $1 AND l.created_at < $2
     GROUP BY l.source
     ORDER BY leads DESC`,
    [start, end],
  );
  return rows.map((r) => ({ ...r, conversion_rate: r.leads ? Math.round((r.booked / r.leads) * 100) : null }));
}

export interface WorkflowHealth {
  exceptions_by_type: { error_type: string; severity: string; open: number; resolved: number }[];
  messages_sent: number;
  messages_failed: number;
  messages_skipped: number;
  jobs_dead: number;
  median_resolution_minutes: number | null;
}

export async function getWorkflowHealth(days: number): Promise<WorkflowHealth> {
  const [start, end] = windowFor(days);
  const [byType, totals] = await Promise.all([
    many<{ error_type: string; severity: string; open: number; resolved: number }>(
      pool(),
      `SELECT error_type, severity,
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'resolved')::int AS resolved
       FROM exceptions WHERE created_at >= $1 AND created_at < $2
       GROUP BY error_type, severity
       ORDER BY open DESC, resolved DESC`,
      [start, end],
    ),
    one<{ sent: number; failed: number; skipped: number; dead: number; median: number | null }>(
      pool(),
      `SELECT
         (SELECT count(*) FROM communication_log WHERE created_at >= $1 AND created_at < $2
            AND delivery_status IN ('sent','delivered','read'))::int AS sent,
         (SELECT count(*) FROM communication_log WHERE created_at >= $1 AND created_at < $2 AND delivery_status = 'failed')::int AS failed,
         (SELECT count(*) FROM communication_log WHERE created_at >= $1 AND created_at < $2 AND delivery_status = 'skipped')::int AS skipped,
         (SELECT count(*) FROM jobs WHERE status = 'dead' AND updated_at >= $1 AND updated_at < $2)::int AS dead,
         (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM resolved_at - created_at)) / 60)::int
            FROM exceptions WHERE resolved_at IS NOT NULL AND created_at >= $1 AND created_at < $2) AS median`,
      [start, end],
    ),
  ]);
  return {
    exceptions_by_type: byType,
    messages_sent: totals!.sent,
    messages_failed: totals!.failed,
    messages_skipped: totals!.skipped,
    jobs_dead: totals!.dead,
    median_resolution_minutes: totals!.median,
  };
}

export interface DailyPoint {
  day: string;
  leads: number;
  booked: number;
}

export async function getDailyTrend(days: number): Promise<DailyPoint[]> {
  const [start, end] = windowFor(days);
  return many<DailyPoint>(
    pool(),
    `WITH days AS (
       SELECT generate_series($1::timestamptz, $2::timestamptz - interval '1 day', interval '1 day') AS d
     )
     SELECT to_char(d AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM leads l WHERE l.created_at >= d AND l.created_at < d + interval '1 day')::int AS leads,
            (SELECT count(*) FROM appointments a WHERE a.created_at >= d AND a.created_at < d + interval '1 day')::int AS booked
     FROM days ORDER BY d`,
    [start, end],
  );
}

export interface ReportBundle {
  days: number;
  funnel: Funnel;
  response: ResponseTimes;
  departments: DepartmentPerformance[];
  sources: SourcePerformance[];
  health: WorkflowHealth;
  trend: DailyPoint[];
  care: CareStats;
  labs: LabStats;
}

export async function getReport(days: number): Promise<ReportBundle> {
  const [funnel, response, departments, sources, health, trend, care, labs] = await Promise.all([
    getFunnel(days),
    getResponseTimes(days),
    getDepartmentPerformance(days),
    getSourcePerformance(days),
    getWorkflowHealth(days),
    getDailyTrend(days),
    careStats(pool()),
    labStats(pool()),
  ]);
  return { days, funnel, response, departments, sources, health, trend, care, labs };
}

/** Aggregate numbers only: this is what may be sent to an AI provider for the summary. */
export function summaryMetrics(report: ReportBundle) {
  return {
    period_days: report.days,
    enquiries: report.funnel.enquiries,
    booked_automatically: report.funnel.auto_booked,
    booked_by_staff: report.funnel.staff_booked,
    needing_human_review: report.funnel.needs_review,
    no_slot_available: report.funnel.no_slot,
    conversion_rate_percent: report.funnel.conversion_rate,
    median_first_response_seconds: report.response.median_seconds,
    attended: report.funnel.attended,
    no_shows: report.funnel.no_shows,
    cancelled: report.funnel.cancelled,
    messages_sent: report.health.messages_sent,
    messages_failed: report.health.messages_failed,
    open_exceptions: report.health.exceptions_by_type.reduce((n, e) => n + e.open, 0),
    exception_types: report.health.exceptions_by_type.map((e) => ({ type: e.error_type, severity: e.severity, open: e.open })),
    departments: report.departments.map((d) => ({ name: d.department, leads: d.leads, booked: d.booked, no_shows: d.no_shows })),
    chronic_patients_enrolled: report.care.enrolled,
    chronic_due_this_week: report.care.due_this_week,
    chronic_overdue: report.care.overdue,
    chronic_reminders_30d: report.care.reminded_30d,
    lab_reports_awaiting_review: report.labs.awaiting_review,
    lab_abnormal_open: report.labs.abnormal_open,
    lab_patients_told_7d: report.labs.patients_told_7d,
  };
}
