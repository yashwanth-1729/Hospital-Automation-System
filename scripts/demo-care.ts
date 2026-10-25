import "../src/lib/load-env";
import pg from "pg";
import { newCorrelationId, newId } from "../src/lib/ids";
import { addDays, istDateString } from "../src/lib/time";
import { DEMO_DOCTORS } from "./seed";

/**
 * Chronic care plans and lab follow-ups for a sales demo, on top of the demo patients that
 * scripts/demo-data.ts creates. Replaces only care plans, lab tasks and their open tasks, so it
 * can be run on its own:  npm run db:demo:care
 */

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TESTS: [string, string][] = [
  ["HbA1c", "biochemistry"],
  ["Fasting blood sugar", "biochemistry"],
  ["Lipid profile", "biochemistry"],
  ["Serum creatinine", "biochemistry"],
  ["Thyroid profile (TSH)", "biochemistry"],
  ["Complete blood count", "haematology"],
  ["Liver function test", "biochemistry"],
  ["Urine routine", "pathology"],
];

export async function generateCareDemo(connectionString: string): Promise<void> {
  const rand = rng(20261026);
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const chance = (p: number) => rand() < p;
  const today = istDateString();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM exceptions WHERE error_type IN ('CARE_OVERDUE', 'LAB_ABNORMAL', 'LAB_REVIEW_OVERDUE')`);
    await client.query(`DELETE FROM care_plans`);
    await client.query(`DELETE FROM diagnostic_tasks`);
    const patients = (await client.query<{ patient_id: string; full_name: string }>(`SELECT patient_id, full_name FROM patients ORDER BY patient_id`)).rows;
    const pool = [...patients].sort(() => rand() - 0.5);

    // ~22% of patients have a chronic condition: mostly diabetes, then blood pressure, then thyroid.
    const chronic = pool.slice(0, Math.round(patients.length * 0.22));
    let plans = 0;
    for (const p of chronic) {
      const condition = pick(["diabetes", "diabetes", "diabetes", "diabetes", "diabetes", "hypertension", "hypertension", "hypertension", "thyroid"] as const);
      const interval = condition === "thyroid" ? 180 : 90;
      // Where the patient is in their cycle: a few due now, some overdue, most on track.
      const bucket = pick(["due", "due", "overdue", "overdue", "ok", "ok", "ok", "ok", "ok", "ok"] as const);
      const daysToDue = bucket === "due" ? between(-5, 10) : bucket === "overdue" ? -between(8, 45) : between(12, interval - 5);
      const next = addDays(today, daysToDue);
      const last = addDays(next, -interval);
      const reminders = daysToDue <= 3 ? (daysToDue <= -7 ? 2 : 1) : 0;
      const remindedAt = reminders ? `${addDays(today, Math.max(-25, Math.min(0, daysToDue + (reminders === 2 ? 7 : -3))))}T10:${String(between(0, 59)).padStart(2, "0")}:00+05:30` : null;
      const planId = newId("CRP");
      await client.query(
        `INSERT INTO care_plans (plan_id, patient_id, condition, interval_days, last_visit_date, next_due_date, reminders_sent, last_reminded_at, source, correlation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (patient_id, condition) DO NOTHING`,
        [planId, p.patient_id, condition, interval, last, next, reminders, remindedAt, chance(0.7) ? "hms" : "clevo", newCorrelationId(), `${last}T11:00:00+05:30`],
      );
      plans++;
      // Long-overdue patients were escalated to the desk; most have already been called. The dedupe key
      // matches the worker's, so it does not raise them again.
      if (bucket === "overdue" && daysToDue <= -14) {
        const handled = chance(0.85);
        await client.query(
          `INSERT INTO exceptions (exception_id, workflow_name, record_id, error_type, severity, owner, due_at, summary, dedupe_key,
                                   status, resolved_at, resolution_note)
           VALUES ($1, 'HOSPITAL | 05 Clinical Care', $2, 'CARE_OVERDUE', 'medium', 'front_desk', now() + interval '4 hours', $3, $4, $5, $6, $7)`,
          [newId("EXC"), planId, `${p.full_name} is overdue for their ${condition} review and has not replied to two reminders. Please call.`,
            `care-overdue:${planId}:${next}`, handled ? "resolved" : "open", handled ? new Date(Date.now() - between(2, 72) * 3_600_000) : null,
            handled ? "Called the patient; review booked." : null],
        );
      }
    }

    // Lab reports: a dozen waiting, about twenty ready and not yet reviewed, the rest reviewed this week.
    const doctors = (await client.query<{ user_id: string }>(`SELECT user_id FROM staff_users WHERE role IN ('doctor', 'admin') AND active ORDER BY role DESC`)).rows;
    const reviewer = doctors[0]?.user_id ?? null;
    const labPatients = pool.slice(0, 80);
    let labs = 0;
    for (const [i, p] of labPatients.entries()) {
      const [test, category] = pick(TESTS);
      const doctor = pick(DEMO_DOCTORS).name;
      const state = i < 12 ? "waiting" : i < 32 ? "review" : "done";
      const orderedHoursAgo = state === "waiting" ? between(4, 80) : between(30, 160);
      const readyHoursAgo = state === "waiting" ? null : state === "review" ? between(1, 26) : between(20, Math.max(21, orderedHoursAgo - 4));
      const abnormal = state !== "waiting" && chance(state === "review" ? 0.22 : 0.15);
      const id = newId("LAB");
      await client.query(
        `INSERT INTO diagnostic_tasks (diagnostic_id, patient_id, test_category, test_name, doctor_name, ordered_at, completed_at, report_ready_at,
                                       result_flag, notified_at, notification_status, review_status, reviewed_at, reviewed_by, source, correlation_id, external_id)
         VALUES ($1, $2, $3, $4, $5, now() - make_interval(hours => $6), $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id, p.patient_id, category, test, doctor, orderedHoursAgo,
          readyHoursAgo === null ? null : new Date(Date.now() - readyHoursAgo * 3_600_000),
          state === "waiting" ? null : abnormal ? "abnormal" : "normal",
          readyHoursAgo === null ? null : new Date(Date.now() - (readyHoursAgo - 0.05) * 3_600_000),
          readyHoursAgo === null ? "pending" : "sent",
          state === "done" ? "reviewed" : "pending",
          state === "done" ? new Date(Date.now() - Math.max(1, (readyHoursAgo ?? 2) - between(1, 12)) * 3_600_000) : null,
          state === "done" ? reviewer : null,
          chance(0.75) ? "hms" : "clevo",
          newCorrelationId(),
          `demo:${id}`,
        ],
      );
      labs++;
      if (state === "review" && abnormal) {
        await client.query(
          `INSERT INTO exceptions (exception_id, workflow_name, record_id, error_type, severity, owner, due_at, summary, dedupe_key)
           VALUES ($1, 'HOSPITAL | 05 Clinical Care', $2, 'LAB_ABNORMAL', 'high', 'doctor', now() + interval '1 hour', $3, $4)`,
          [newId("EXC"), id, `Abnormal ${test} result for ${p.full_name} (${doctor}). Please review today.`, `lab-abnormal:${id}`],
        );
      }
    }
    await client.query("COMMIT");
    console.log(`care plans: ${plans}, lab reports: ${labs}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("demo-care.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  generateCareDemo(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
