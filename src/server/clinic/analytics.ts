import { many, one, type Db } from "@/lib/db";
import { addDays, istAt, istDateString } from "@/lib/time";

export interface DayPoint {
  date: string;
  value: number;
}

export interface Analytics {
  from: string;
  to: string;
  days: number;
  visits: { total: number; completed: number; walk_in: number; appointment: number; cancelled: number };
  visits_by_day: DayPoint[];
  wait: { average_minutes: number | null; longest_minutes: number | null };
  doctors: { doctor_id: string; name: string; department: string; seen: number; avg_wait: number | null }[];
  departments: { department: string; visits: number }[];
  diagnoses: { diagnosis: string; n: number }[];
  money: { billed: number; collected: number; refunded: number; outstanding: number; pharmacy_sales: number };
  collected_by_day: DayPoint[];
  medicines: { name: string; quantity: number; revenue: number }[];
  inpatients: { admitted: number; discharged: number; current: number; average_stay_days: number | null };
}

/** Fills days with no activity with zero, so a chart shows the quiet days too. */
function dense(from: string, to: string, rows: { date: string; value: number }[]): DayPoint[] {
  const byDate = new Map(rows.map((r) => [r.date, r.value]));
  const out: DayPoint[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, value: byDate.get(d) ?? 0 });
  return out;
}

export async function hospitalAnalytics(db: Db, days = 14): Promise<Analytics> {
  const to = istDateString();
  const from = addDays(to, -(days - 1));
  const start = istAt(from, 0);
  const end = istAt(addDays(to, 1), 0);

  const [visitCounts, byDay, wait, doctors, departments, diagnoses, money, collectedByDay, medicines, inpatients] = await Promise.all([
    one<Analytics["visits"]>(
      db,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE source = 'walk_in')::int AS walk_in,
              count(*) FILTER (WHERE source = 'appointment')::int AS appointment,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM visits WHERE visit_date BETWEEN $1 AND $2`,
      [from, to],
    ),
    many<{ date: string; value: number }>(
      db,
      `SELECT visit_date AS date, count(*)::int AS value FROM visits
        WHERE visit_date BETWEEN $1 AND $2 AND status <> 'cancelled' GROUP BY visit_date`,
      [from, to],
    ),
    one<{ average_minutes: number | null; longest_minutes: number | null }>(
      db,
      `SELECT round(avg(EXTRACT(EPOCH FROM (consult_started_at - checked_in_at)) / 60))::int AS average_minutes,
              round(max(EXTRACT(EPOCH FROM (consult_started_at - checked_in_at)) / 60))::int AS longest_minutes
         FROM visits WHERE visit_date BETWEEN $1 AND $2 AND consult_started_at IS NOT NULL`,
      [from, to],
    ),
    many<Analytics["doctors"][number]>(
      db,
      `SELECT d.doctor_id, d.full_name AS name, dep.name AS department,
              count(*) FILTER (WHERE v.status = 'completed')::int AS seen,
              round(avg(EXTRACT(EPOCH FROM (v.consult_started_at - v.checked_in_at)) / 60)
                    FILTER (WHERE v.consult_started_at IS NOT NULL))::int AS avg_wait
         FROM visits v JOIN doctors d ON d.doctor_id = v.doctor_id JOIN departments dep ON dep.department_id = v.department_id
        WHERE v.visit_date BETWEEN $1 AND $2 AND v.status <> 'cancelled'
        GROUP BY d.doctor_id, dep.name ORDER BY seen DESC, d.full_name`,
      [from, to],
    ),
    many<{ department: string; visits: number }>(
      db,
      `SELECT dep.name AS department, count(*)::int AS visits
         FROM visits v JOIN departments dep ON dep.department_id = v.department_id
        WHERE v.visit_date BETWEEN $1 AND $2 AND v.status <> 'cancelled'
        GROUP BY dep.name ORDER BY visits DESC`,
      [from, to],
    ),
    many<{ diagnosis: string; n: number }>(
      db,
      `SELECT initcap(lower(btrim(c.diagnosis))) AS diagnosis, count(*)::int AS n
         FROM consultations c JOIN visits v ON v.visit_id = c.visit_id
        WHERE c.status = 'final' AND v.visit_date BETWEEN $1 AND $2 AND btrim(c.diagnosis) <> ''
        GROUP BY lower(btrim(c.diagnosis)), initcap(lower(btrim(c.diagnosis))) ORDER BY n DESC, diagnosis LIMIT 8`,
      [from, to],
    ),
    one<Analytics["money"]>(
      db,
      `SELECT
         COALESCE((SELECT sum(total) FROM invoices WHERE issued_at >= $1 AND issued_at < $2 AND status <> 'void'), 0)::float AS billed,
         COALESCE((SELECT sum(amount) FROM payments WHERE kind = 'payment' AND received_at >= $1 AND received_at < $2), 0)::float AS collected,
         COALESCE((SELECT sum(amount) FROM payments WHERE kind = 'refund' AND received_at >= $1 AND received_at < $2), 0)::float AS refunded,
         COALESCE((SELECT sum(total - amount_paid) FROM invoices WHERE status IN ('issued', 'partially_paid')), 0)::float AS outstanding,
         COALESCE((SELECT sum(l.line_total) FROM invoice_lines l JOIN invoices i ON i.invoice_id = l.invoice_id
                    WHERE l.kind = 'pharmacy' AND i.status <> 'void' AND i.issued_at >= $1 AND i.issued_at < $2), 0)::float AS pharmacy_sales`,
      [start, end],
    ),
    many<{ date: string; value: number }>(
      db,
      `SELECT (received_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date,
              sum(CASE WHEN kind = 'payment' THEN amount ELSE -amount END)::float AS value
         FROM payments WHERE received_at >= $1 AND received_at < $2 GROUP BY 1`,
      [start, end],
    ),
    many<Analytics["medicines"][number]>(
      db,
      `SELECT m.name, sum(di.quantity)::int AS quantity, sum(di.line_total)::float AS revenue
         FROM dispensation_items di
         JOIN dispensations x ON x.dispensation_id = di.dispensation_id
         JOIN medicines m ON m.medicine_id = di.medicine_id
        WHERE x.dispensed_at >= $1 AND x.dispensed_at < $2
        GROUP BY m.name ORDER BY quantity DESC, m.name LIMIT 8`,
      [start, end],
    ),
    one<{ admitted: number; discharged: number; current: number; average_stay_days: number | null }>(
      db,
      `SELECT count(*) FILTER (WHERE admitted_at >= $1 AND admitted_at < $2)::int AS admitted,
              count(*) FILTER (WHERE discharged_at >= $1 AND discharged_at < $2)::int AS discharged,
              count(*) FILTER (WHERE status = 'admitted')::int AS current,
              round(avg(EXTRACT(EPOCH FROM (discharged_at - admitted_at)) / 86400)
                    FILTER (WHERE discharged_at >= $1 AND discharged_at < $2)::numeric, 1)::float AS average_stay_days
         FROM admissions`,
      [start, end],
    ),
  ]);

  return {
    from,
    to,
    days,
    visits: visitCounts!,
    visits_by_day: dense(from, to, byDay),
    wait: wait!,
    doctors,
    departments,
    diagnoses,
    money: money!,
    collected_by_day: dense(from, to, collectedByDay),
    medicines,
    inpatients: inpatients!,
  };
}
