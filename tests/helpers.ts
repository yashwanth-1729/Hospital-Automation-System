import { many, one, pool } from "@/lib/db";
import { addDays, istAt, istDateString } from "@/lib/time";
import { DEMO_DEPARTMENTS, DEMO_DOCTORS } from "../scripts/seed";

const TABLES = [
  "prescription_items", "prescriptions", "consultation_addenda", "consultations", "vitals", "medicines",
  "visit_tokens", "visits", "audit_log", "communication_log", "exceptions", "jobs", "follow_ups", "diagnostic_tasks",
  "feedback", "feedback_requests", "discharges", "daily_summaries",
  "worker_heartbeats", "staff_sessions", "staff_users", "login_failures", "slots", "appointments", "leads", "patients", "doctors", "departments",
];

/** Empties every table and loads departments + doctors (no slots). */
export async function resetData() {
  await pool().query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  for (const d of DEMO_DEPARTMENTS) {
    await pool().query(`INSERT INTO departments (department_id, name) VALUES ($1, $2)`, [d.id, d.name]);
  }
  for (const d of DEMO_DOCTORS) {
    await pool().query(`INSERT INTO doctors (doctor_id, department_id, full_name) VALUES ($1, $2, $3)`, [d.id, d.dept, d.name]);
  }
}

export function futureDate(daysAhead = 2): string {
  return addDays(istDateString(), daysAhead);
}

export async function addSlot(doctorId: string, date: string, hour: number, minute = 0): Promise<string> {
  const doc = DEMO_DOCTORS.find((d) => d.id === doctorId)!;
  const start = istAt(date, hour, minute);
  const slotId = `SLOT-T-${doctorId}-${date}-${hour}${minute}`;
  // Re-adding the same slot in one test is a no-op, not an error.
  await pool().query(
    `INSERT INTO slots (slot_id, doctor_id, department_id, slot_start, slot_end) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (doctor_id, slot_start) DO NOTHING`,
    [slotId, doctorId, doc.dept, start, new Date(start.getTime() + 30 * 60_000)],
  );
  return slotId;
}

export function leadPayload(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "Rahul Sharma",
    phone: "98765 43210",
    department: "Dermatology",
    preferred_date: futureDate(2),
    enquiry_text: "I want to book a consultation.",
    source: "Instagram",
    consent: true,
    ...overrides,
  };
}

export const q = {
  lead: (id: string) => one<Record<string, any>>(pool(), `SELECT * FROM leads WHERE lead_id = $1`, [id]),
  appointments: () => many<Record<string, any>>(pool(), `SELECT * FROM appointments ORDER BY created_at`),
  messages: () => many<Record<string, any>>(pool(), `SELECT * FROM communication_log ORDER BY created_at`),
  exceptions: () => many<Record<string, any>>(pool(), `SELECT * FROM exceptions ORDER BY created_at`),
  jobs: (type?: string) =>
    many<Record<string, any>>(pool(), `SELECT * FROM jobs WHERE $1::text IS NULL OR type = $1 ORDER BY job_id`, [type ?? null]),
  auditActions: (correlationId: string) =>
    many<{ action: string }>(pool(), `SELECT action FROM audit_log WHERE correlation_id = $1 ORDER BY event_id`, [correlationId]).then(
      (r) => r.map((x) => x.action),
    ),
};
