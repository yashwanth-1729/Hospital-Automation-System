import "../src/lib/load-env";
import pg from "pg";
import { newCorrelationId, newId } from "../src/lib/ids";
import { addDays, formatSlot, istAt, istDateString, istDayRange } from "../src/lib/time";
import { generateClinicHistory } from "./demo-clinic";
import { DEMO_DEPARTMENTS, DEMO_DOCTORS, seed } from "./seed";
import { generateCareDemo } from "./demo-care";

/**
 * Fills the demo hospital with a realistic month of history so the dashboard and reports
 * look like a working hospital during a sales demo.
 *
 * This writes records directly (it does not replay the workflows) because history has to be
 * backdated. Live behaviour still comes from the real code paths.
 *
 *   npx tsx scripts/demo-data.ts [--days 30]
 */

const FIRST_NAMES = [
  "Rahul", "Priya", "Anil", "Sunita", "Vikram", "Meena", "Arjun", "Kavya", "Ramesh", "Divya",
  "Suresh", "Anjali", "Karthik", "Pooja", "Manoj", "Sneha", "Rajesh", "Lakshmi", "Nikhil", "Deepa",
  "Sanjay", "Ritu", "Amit", "Neha", "Vijay", "Shalini", "Harish", "Preeti", "Girish", "Asha",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Reddy", "Nair", "Iyer", "Patel", "Kumar", "Joshi", "Desai", "Rao",
  "Menon", "Gupta", "Pillai", "Shetty", "Bhat", "Chawla", "Kulkarni", "Mehta",
];

const SOURCES = [
  { name: "Instagram", weight: 30 },
  { name: "Google Ads", weight: 28 },
  { name: "website", weight: 25 },
  { name: "Referral", weight: 10 },
  { name: "Walk-in enquiry", weight: 7 },
];

const ENQUIRIES: Record<string, string[]> = {
  cardiology: [
    "Want to book a consultation for blood pressure check",
    "Need an appointment for ECG review",
    "My father needs a cardiology consultation",
    "Booking for heart checkup package",
  ],
  dermatology: [
    "I want to book a consultation for acne",
    "Hair fall problem, need appointment",
    "Skin allergy consultation please",
    "Booking for pigmentation treatment consultation",
  ],
  orthopedics: [
    "Knee pain since one month, want appointment",
    "Need consultation for back pain",
    "Shoulder injury, please book me",
    "mere ghutne me dard hai, appointment chahiye",
  ],
  general_medicine: [
    "Fever and cold for three days, need appointment",
    "Diabetes follow-up consultation",
    "General health checkup booking",
    "Thyroid test consultation please",
  ],
};

const REVIEW_ENQUIRIES = [
  "Hello, what are your OPD timings?",
  "Do you accept insurance for surgery?",
  "which medicine should I take for my acne?",
  "Is my blood report normal?",
  "I need urgent appointment today",
];

const POSITIVE_COMMENTS = [
  "Staff were very helpful and polite.",
  "Doctor explained everything clearly.",
  "Quick service, no waiting.",
  null,
  null,
];
const NEGATIVE_COMMENTS = [
  "Waiting time at billing was too long.",
  "Had to wait an hour past my appointment time.",
  "Reception did not answer my calls.",
];

// Deterministic pseudo-random so repeated runs produce the same demo history.
let seedState = 20260920;
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const chance = (p: number) => rnd() < p;
const intBetween = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

function weightedSource(): string {
  const total = SOURCES.reduce((n, s) => n + s.weight, 0);
  let r = rnd() * total;
  for (const s of SOURCES) {
    r -= s.weight;
    if (r <= 0) return s.name;
  }
  return SOURCES[0]!.name;
}

interface Ctx {
  client: pg.Client;
  phoneCounter: number;
}

async function makePatient(ctx: Ctx, consent: boolean): Promise<{ id: string; name: string; phone: string }> {
  const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  const phone = `+9198${String(70000000 + ctx.phoneCounter++).slice(0, 8)}`;
  const id = newId("PAT");
  await ctx.client.query(
    `INSERT INTO patients (patient_id, full_name, phone, source, consent_status, created_at, updated_at)
     VALUES ($1, $2, $3, 'demo', $4, now(), now())`,
    [id, name, phone, consent ? "granted" : "unknown"],
  );
  return { id, name, phone };
}

async function logMessage(
  ctx: Ctx,
  opts: { patientId: string; recipient: string; template: string; workflow: string; body: string; at: Date; correlationId: string },
) {
  await ctx.client.query(
    `INSERT INTO communication_log (message_id, dedupe_key, patient_id, recipient, channel, provider, template_name,
                                    workflow_name, body, delivery_status, provider_message_id, sent_at, correlation_id,
                                    created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'whatsapp', 'mock', $5, $6, $7, 'sent', $8, $9, $10, $9, $9)`,
    [
      newId("MSG"),
      `demo:${newId("K")}`,
      opts.patientId,
      opts.recipient,
      opts.template,
      opts.workflow,
      opts.body,
      newId("MOCKWA"),
      opts.at,
      opts.correlationId,
    ],
  );
}

async function logAudit(
  ctx: Ctx,
  opts: { workflow: string; actor: string; action: string; recordId: string; at: Date; correlationId: string; details?: unknown },
) {
  await ctx.client.query(
    `INSERT INTO audit_log (workflow_name, workflow_version, actor_type, action, record_id, details, correlation_id, timestamp)
     VALUES ($1, '1.0.0', $2, $3, $4, $5, $6, $7)`,
    [opts.workflow, opts.actor, opts.action, opts.recordId, opts.details ?? null, opts.correlationId, opts.at],
  );
}

async function pastSlot(ctx: Ctx, departmentId: string, when: Date): Promise<{ slotId: string; doctorId: string; doctorName: string; end: Date } | null> {
  const doctors = DEMO_DOCTORS.filter((d) => d.dept === departmentId);
  const doctor = pick(doctors);
  const end = new Date(when.getTime() + 30 * 60_000);
  const slotId = `SLOT-H-${doctor.id}-${when.getTime()}`;
  const r = await ctx.client.query(
    `INSERT INTO slots (slot_id, doctor_id, department_id, slot_start, slot_end, status)
     VALUES ($1, $2, $3, $4, $5, 'booked')
     ON CONFLICT (doctor_id, slot_start) DO NOTHING
     RETURNING slot_id`,
    [slotId, doctor.id, departmentId, when, end],
  );
  if (!r.rows[0]) return null; // that doctor is already busy at this time
  return { slotId, doctorId: doctor.id, doctorName: doctor.name, end };
}

/** One enquiry and everything that followed from it, on a given past day. */
async function generateLead(ctx: Ctx, day: string, hospitalName: string) {
  const correlationId = newCorrelationId(new Date(`${day}T06:00:00Z`));
  const source = weightedSource();
  const enquiryAt = istAt(day, intBetween(8, 21), intBetween(0, 59));
  const consent = chance(0.92);
  const patient = await makePatient(ctx, consent);

  const goesToReview = chance(0.12);
  const departmentId = goesToReview ? pick(DEMO_DEPARTMENTS).id : pick(DEMO_DEPARTMENTS).id;
  const enquiryText = goesToReview ? pick(REVIEW_ENQUIRIES) : pick(ENQUIRIES[departmentId]!);
  const departmentName = DEMO_DEPARTMENTS.find((d) => d.id === departmentId)!.name;
  const leadId = newId("LEAD");
  const respondedAt = new Date(enquiryAt.getTime() + intBetween(1, 4) * 1000);

  // Visit day: 1-6 days after the enquiry, but only if that is still in the past.
  const visitDay = addDays(day, intBetween(1, 6));
  const inPast = visitDay < istDateString();
  const visitAt = istAt(visitDay, intBetween(10, 17), chance(0.5) ? 0 : 30);

  const slot = goesToReview || !inPast ? null : await pastSlot(ctx, departmentId, visitAt);
  const status = goesToReview ? "needs_review" : slot ? "booked" : "no_slot";

  await ctx.client.query(
    `INSERT INTO leads (lead_id, patient_id, idempotency_key, correlation_id, source, enquiry_text, department_requested,
                        preferred_date, department, enquiry_type, patient_status, priority, status, owner,
                        first_response_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', $11, $12, $13, $14, $15, $15)`,
    [
      leadId, patient.id, `demo:${leadId}`, correlationId, source, enquiryText, departmentName, visitDay,
      goesToReview ? null : departmentId,
      goesToReview ? "general_enquiry" : "appointment_booking",
      goesToReview ? "review" : "normal",
      status,
      goesToReview || !slot ? "front_desk" : null,
      consent ? respondedAt : null,
      enquiryAt,
    ],
  );
  await logAudit(ctx, { workflow: "HOSPITAL | 01 Lead Intake", actor: "patient", action: "lead.received", recordId: leadId, at: enquiryAt, correlationId, details: { source } });
  await logAudit(ctx, { workflow: "HOSPITAL | 01 Lead Intake", actor: "system", action: "lead.classified", recordId: leadId, at: new Date(enquiryAt.getTime() + 900), correlationId, details: { department: departmentId, provider: "rules" } });

  if (goesToReview || !slot) {
    await ctx.client.query(
      `INSERT INTO exceptions (exception_id, workflow_name, record_id, error_type, severity, owner, due_at, status,
                               summary, dedupe_key, correlation_id, created_at, resolved_at, resolution_note)
       VALUES ($1, 'HOSPITAL | 01 Lead Intake', $2, $3, 'medium', 'front_desk', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        newId("EXC"), leadId,
        goesToReview ? "NEEDS_HUMAN_REVIEW" : "NO_SLOT_AVAILABLE",
        new Date(enquiryAt.getTime() + 4 * 3600_000),
        chance(0.8) ? "resolved" : "open",
        goesToReview ? `Enquiry from ${patient.name} needs a person to decide.` : `No slot on ${visitDay} for ${patient.name}.`,
        `demo-lead-review:${leadId}`, correlationId, enquiryAt,
        chance(0.8) ? new Date(enquiryAt.getTime() + intBetween(20, 200) * 60_000) : null,
        "Front desk called the patient.",
      ],
    );
    if (consent) {
      await logMessage(ctx, {
        patientId: patient.id, recipient: patient.phone, template: "ENQUIRY_ACK_01", workflow: "HOSPITAL | 01 Lead Intake",
        body: `Hello ${patient.name}, thank you for contacting ${hospitalName}. Our team has received your enquiry and will contact you shortly to help you further.`,
        at: respondedAt, correlationId,
      });
    }
    return;
  }

  // Booked: confirmation, reminders, attendance.
  const appointmentId = newId("APT");
  const attended = chance(0.83);
  const attendanceAt = new Date(visitAt.getTime() + 45 * 60_000);
  await ctx.client.query(
    `INSERT INTO appointments (appointment_id, patient_id, lead_id, department_id, doctor_id, slot_id, slot_start, slot_end,
                               status, attendance_status, reminder_24h_at, reminder_3h_at, attendance_marked_at,
                               attendance_marked_by, correlation_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'booked', $9, $10, $11, $12, $13, $14, $15, $15)`,
    [
      appointmentId, patient.id, leadId, departmentId, slot.doctorId, slot.slotId, visitAt, slot.end,
      attended ? "attended" : "no_show",
      new Date(visitAt.getTime() - 24 * 3600_000),
      new Date(visitAt.getTime() - 3 * 3600_000),
      attendanceAt,
      chance(0.5) ? "staff" : "system",
      correlationId, respondedAt,
    ],
  );
  await ctx.client.query(`UPDATE slots SET appointment_id = $2 WHERE slot_id = $1`, [slot.slotId, appointmentId]);
  await ctx.client.query(`UPDATE leads SET appointment_id = $2 WHERE lead_id = $1`, [leadId, appointmentId]);
  await logAudit(ctx, { workflow: "HOSPITAL | 02 Appointment", actor: "system", action: "appointment.booked", recordId: appointmentId, at: respondedAt, correlationId, details: { doctor_id: slot.doctorId } });

  if (consent) {
    await logMessage(ctx, {
      patientId: patient.id, recipient: patient.phone, template: "APPT_CONFIRM_01", workflow: "HOSPITAL | 02 Appointment",
      body: `Hello ${patient.name}, your appointment at ${hospitalName} is confirmed.\nDepartment: ${departmentName}\nDoctor: ${slot.doctorName}\nDate & time: ${formatSlot(visitAt)}\nBooking ID: ${appointmentId}\nPlease arrive 15 minutes early.`,
      at: respondedAt, correlationId,
    });
    await logMessage(ctx, {
      patientId: patient.id, recipient: patient.phone, template: "APPT_REMINDER_01", workflow: "HOSPITAL | 02 Appointment",
      body: `Reminder: ${patient.name}, you have an appointment at ${hospitalName} with ${slot.doctorName} on ${formatSlot(visitAt)}.`,
      at: new Date(visitAt.getTime() - 24 * 3600_000), correlationId,
    });
  }

  if (!attended) {
    await generateNoShowRecovery(ctx, { patient, appointmentId, correlationId, attendanceAt, doctorName: slot.doctorName, departmentName, hospitalName, consent });
    return;
  }

  // Some attended visits were inpatient stays that end in a discharge.
  if (chance(0.3)) {
    await generateDischarge(ctx, { patient, departmentId, departmentName, correlationId, dischargedAt: new Date(attendanceAt.getTime() + 2 * 3600_000), hospitalName, consent });
  }
}

async function generateNoShowRecovery(
  ctx: Ctx,
  o: { patient: { id: string; name: string; phone: string }; appointmentId: string; correlationId: string; attendanceAt: Date; doctorName: string; departmentName: string; hospitalName: string; consent: boolean },
) {
  await logAudit(ctx, { workflow: "HOSPITAL | 03 No-Show Recovery", actor: "system", action: "attendance.marked", recordId: o.appointmentId, at: o.attendanceAt, correlationId: o.correlationId, details: { attendance: "no_show" } });
  const messageAt = new Date(o.attendanceAt.getTime() + 30 * 60_000);
  if (o.consent) {
    await logMessage(ctx, {
      patientId: o.patient.id, recipient: o.patient.phone, template: "NOSHOW_RECOVERY_01", workflow: "HOSPITAL | 03 No-Show Recovery",
      body: `Hello ${o.patient.name}, we missed you at ${o.hospitalName} for your appointment with ${o.doctorName}. Would you like to reschedule?`,
      at: messageAt, correlationId: o.correlationId,
    });
  }
  const recovered = chance(0.38);
  await ctx.client.query(
    `INSERT INTO follow_ups (followup_id, patient_id, appointment_id, category, owner, status, attempt_count,
                             next_action_at, notes, dedupe_key, correlation_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'no_show_recovery', 'front_desk', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      newId("FUP"), o.patient.id, o.appointmentId,
      recovered ? "done" : chance(0.5) ? "open" : "cancelled",
      intBetween(1, 2),
      new Date(messageAt.getTime() + 24 * 3600_000),
      recovered ? "Recovered: patient rebooked." : `Missed ${o.departmentName} appointment.`,
      `demo-noshow:${o.appointmentId}`, o.correlationId, messageAt,
      new Date(messageAt.getTime() + intBetween(1, 48) * 3600_000),
    ],
  );
  if (recovered) {
    await logAudit(ctx, { workflow: "HOSPITAL | 03 No-Show Recovery", actor: "system", action: "noshow.recovered", recordId: o.appointmentId, at: new Date(messageAt.getTime() + 20 * 3600_000), correlationId: o.correlationId });
  }
}

async function generateDischarge(
  ctx: Ctx,
  o: { patient: { id: string; name: string; phone: string }; departmentId: string; departmentName: string; correlationId: string; dischargedAt: Date; hospitalName: string; consent: boolean },
) {
  const dischargeId = newId("DIS");
  const approvedDate = addDays(istDateString(o.dischargedAt), intBetween(7, 21));
  const approver = pick(DEMO_DOCTORS.filter((d) => d.dept === o.departmentId)).name;
  await ctx.client.query(
    `INSERT INTO discharges (discharge_id, patient_id, encounter_id, department_id, discharged_at, approved_followup_date,
                             approved_followup_window, approved_by, source, status, idempotency_key, correlation_id,
                             created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'hms', 'scheduled', $9, $10, $5, $5)`,
    [
      dischargeId, o.patient.id, `IP-${intBetween(2026000, 2026999)}`, o.departmentId, o.dischargedAt, approvedDate,
      chance(0.5) ? "Morning OPD" : "Evening OPD", approver, `demo:${dischargeId}`, `${o.correlationId}-D`,
    ],
  );
  if (o.consent) {
    await logMessage(ctx, {
      patientId: o.patient.id, recipient: o.patient.phone, template: "DISCHARGE_FOLLOWUP_01", workflow: "HOSPITAL | 04 Discharge Follow-Up",
      body: `Hello ${o.patient.name}, thank you for choosing ${o.hospitalName}. Your care team has scheduled a follow-up visit on ${approvedDate}.`,
      at: o.dischargedAt, correlationId: `${o.correlationId}-D`,
    });
  }

  // Feedback request 48h later, answered by about two thirds of patients.
  const requestAt = new Date(o.dischargedAt.getTime() + 48 * 3600_000);
  if (requestAt.getTime() > Date.now() || !o.consent) return;

  const token = newId("TOK").toLowerCase();
  await ctx.client.query(
    `INSERT INTO feedback_requests (token, patient_id, discharge_id, correlation_id, expires_at, responded_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, o.patient.id, dischargeId, `${o.correlationId}-D`, new Date(requestAt.getTime() + 30 * 86400_000), null, requestAt],
  );
  await logMessage(ctx, {
    patientId: o.patient.id, recipient: o.patient.phone, template: "FEEDBACK_REQUEST_01", workflow: "HOSPITAL | 04 Discharge Follow-Up",
    body: `Hello ${o.patient.name}, could you rate your recent experience at ${o.hospitalName}?`,
    at: requestAt, correlationId: `${o.correlationId}-D`,
  });

  if (!chance(0.65)) return;
  const rating = chance(0.72) ? intBetween(4, 5) : intBetween(2, 3);
  const answeredAt = new Date(requestAt.getTime() + intBetween(1, 20) * 3600_000);
  await ctx.client.query(`UPDATE feedback_requests SET responded_at = $2 WHERE token = $1`, [token, answeredAt]);
  await ctx.client.query(
    `INSERT INTO feedback (feedback_id, token, patient_id, discharge_id, rating, comment, correlation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId("FBK"), token, o.patient.id, dischargeId, rating, rating >= 4 ? pick(POSITIVE_COMMENTS) : pick(NEGATIVE_COMMENTS), `${o.correlationId}-D`, answeredAt],
  );
  if (rating <= 3) {
    await ctx.client.query(
      `INSERT INTO exceptions (exception_id, workflow_name, record_id, error_type, severity, owner, due_at, status,
                               summary, dedupe_key, correlation_id, created_at, resolved_at, resolution_note)
       VALUES ($1, 'HOSPITAL | 04 Discharge Follow-Up', $2, 'NEGATIVE_FEEDBACK', $3, 'service_recovery', $4, $5, $6, $7, $8, $9, $10, 'Service manager called the patient.')`,
      [
        newId("EXC"), dischargeId, rating <= 2 ? "high" : "medium",
        new Date(answeredAt.getTime() + 4 * 3600_000),
        chance(0.7) ? "resolved" : "open",
        `${o.patient.name} rated their experience ${rating}/5. Service recovery: call the patient.`,
        `demo-feedback:${token}`, `${o.correlationId}-D`, answeredAt,
        chance(0.7) ? new Date(answeredAt.getTime() + intBetween(2, 30) * 3600_000) : null,
      ],
    );
  }
}

const TRANSACTIONAL = [
  "audit_log", "communication_log", "exceptions", "jobs", "feedback", "feedback_requests", "follow_ups",
  "diagnostic_tasks", "discharges", "daily_summaries", "appointments", "leads", "patients",
];

export async function generateDemoData(connectionString: string, days = 30) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const ctx: Ctx = { client, phoneCounter: 0 };
  const hospitalName = process.env.HOSPITAL_NAME ?? "DemoCare Multispeciality Hospital";

  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${TRANSACTIONAL.join(", ")} RESTART IDENTITY CASCADE`);
    // History uses its own slots; live demo slots are regenerated afterwards.
    await client.query(`DELETE FROM slots`);
    await client.query("COMMIT");

    const today = istDateString();
    let leads = 0;
    for (let i = days; i >= 1; i--) {
      const day = addDays(today, -i);
      const weekday = new Date(`${day}T12:00:00+05:30`).getUTCDay();
      if (weekday === 0) continue; // OPD closed on Sundays
      const count = intBetween(4, 11) + (weekday === 6 ? 2 : 0);
      await client.query("BEGIN");
      for (let n = 0; n < count; n++) {
        await generateLead(ctx, day, hospitalName);
        leads++;
      }
      await client.query("COMMIT");
    }

    const [start] = istDayRange(today);
    const stats = await client.query<{ label: string; n: number }>(
      `SELECT 'appointments' AS label, count(*)::int AS n FROM appointments
       UNION ALL SELECT 'no_shows', count(*)::int FROM appointments WHERE attendance_status = 'no_show'
       UNION ALL SELECT 'discharges', count(*)::int FROM discharges
       UNION ALL SELECT 'feedback', count(*)::int FROM feedback
       UNION ALL SELECT 'open_exceptions', count(*)::int FROM exceptions WHERE status = 'open'
       UNION ALL SELECT 'messages', count(*)::int FROM communication_log`,
    );
    console.log(`generated ${leads} enquiries over ${days} days (since ${addDays(today, -days)})`);
    for (const row of stats.rows) console.log(`  ${row.label}: ${row.n}`);
    console.log(`  today starts at ${start.toISOString()}`);
  } finally {
    await client.end();
  }

  // Fresh open slots for the live part of the demo.
  await seed(connectionString, { days: 14, quiet: true });
  console.log("open slots regenerated for the next 14 days");

  // The hospital operating system's side: visits, prescriptions, dispensing, invoices, wards.
  await generateClinicHistory(connectionString, { days: Math.min(days, 21) });

  // Chronic care plans and lab follow-ups for the demo patients.
  await generateCareDemo(connectionString);
}

if (process.argv[1]?.endsWith("demo-data.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const idx = process.argv.indexOf("--days");
  const days = idx > -1 ? Number(process.argv[idx + 1]) : 30;
  generateDemoData(url, Number.isFinite(days) && days > 0 ? days : 30).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
