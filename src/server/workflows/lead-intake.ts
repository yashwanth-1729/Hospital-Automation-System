import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { many, one, pool, tx } from "@/lib/db";
import { env } from "@/lib/env";
import { raiseException } from "@/lib/exceptions";
import { CORRELATION_ID_PATTERN, newCorrelationId, newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { normalizeIndianPhone } from "@/lib/phone";
import { addDays, istDateString, istDayRange, isValidDateString } from "@/lib/time";
import { classifyLead, NEEDS_HUMAN_REVIEW, type DepartmentOption, type LeadClassification } from "@/server/ai";
import { JOB } from "./job-types";

/** Latest a patient can ask to be seen, relative to today. */
const MAX_BOOKING_HORIZON_DAYS = 60;
/** Never book a slot starting sooner than this. */
const MIN_LEAD_TIME_MINUTES = 30;

export const LeadPayloadSchema = z.object({
  full_name: z.string().trim().min(2, "Name is too short").max(120),
  phone: z.string().trim().min(6, "Enter a valid 10-digit Indian mobile number").max(20, "Enter a valid 10-digit Indian mobile number"),
  email: z.preprocess((v) => (v === "" ? undefined : v), z.email().max(200).optional()),
  city: z.string().trim().max(80).optional(),
  department: z.string().trim().max(60).optional().nullable(),
  preferred_date: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().refine(isValidDateString, "preferred_date must be YYYY-MM-DD").optional().nullable(),
  ),
  enquiry_text: z.string().trim().min(3, "Please describe your enquiry").max(2000),
  source: z.string().trim().min(1).max(60).default("website"),
  campaign: z.string().trim().max(120).optional().nullable(),
  consent: z.boolean().optional(),
  correlation_id: z.string().regex(CORRELATION_ID_PATTERN).optional(),
});
export type LeadPayload = z.input<typeof LeadPayloadSchema>;

export type IntakeResult =
  | { ok: true; leadId: string; correlationId: string; duplicate: boolean }
  | { ok: false; errors: Record<string, string> };

function idempotencyKey(p: z.infer<typeof LeadPayloadSchema>, phone: string): string {
  if (p.correlation_id) return `cid:${p.correlation_id}`;
  const text = p.enquiry_text.toLowerCase().replace(/\s+/g, " ");
  const raw = [phone, p.department ?? "", p.preferred_date ?? "", p.source.toLowerCase(), istDateString(), text].join("|");
  return `h:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

/** Step 1 (synchronous, from the webhook): validate, store, queue. Fast and idempotent. */
export async function intakeLead(input: unknown): Promise<IntakeResult> {
  const parsed = LeadPayloadSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) errors[issue.path.join(".") || "_"] ??= issue.message;
    return { ok: false, errors };
  }
  const p = parsed.data;
  const phone = normalizeIndianPhone(p.phone);
  if (!phone) return { ok: false, errors: { phone: "Enter a valid 10-digit Indian mobile number" } };

  if (p.preferred_date) {
    const today = istDateString();
    if (p.preferred_date < today) return { ok: false, errors: { preferred_date: "Date cannot be in the past" } };
    if (p.preferred_date > addDays(today, MAX_BOOKING_HORIZON_DAYS)) {
      return { ok: false, errors: { preferred_date: `Date must be within ${MAX_BOOKING_HORIZON_DAYS} days` } };
    }
  }

  const key = idempotencyKey(p, phone);
  const consent = p.consent === undefined ? null : p.consent ? "granted" : "denied";

  return tx(async (c) => {
    const existingLead = await one<{ lead_id: string; correlation_id: string }>(
      c,
      `SELECT lead_id, correlation_id FROM leads WHERE idempotency_key = $1`,
      [key],
    );
    if (existingLead) {
      return { ok: true as const, leadId: existingLead.lead_id, correlationId: existingLead.correlation_id, duplicate: true };
    }

    // Upsert patient by phone. Existing details are kept; consent follows the latest explicit answer.
    const patient = (await one<{ patient_id: string; inserted: boolean }>(
      c,
      `INSERT INTO patients (patient_id, full_name, phone, email, city, source, consent_status)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'unknown'))
       ON CONFLICT (phone) DO UPDATE SET
         consent_status = COALESCE($7, patients.consent_status),
         email = COALESCE(patients.email, EXCLUDED.email),
         updated_at = now()
       RETURNING patient_id, (xmax = 0) AS inserted`,
      [newId("PAT"), p.full_name, phone, p.email ?? null, p.city ?? null, p.source, consent],
    ))!;

    const leadId = newId("LEAD");
    const correlationId = p.correlation_id ?? newCorrelationId();
    const inserted = await one<{ lead_id: string }>(
      c,
      `INSERT INTO leads (lead_id, patient_id, idempotency_key, correlation_id, source, campaign, enquiry_text,
                          department_requested, preferred_date, patient_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING lead_id`,
      [leadId, patient.patient_id, key, correlationId, p.source, p.campaign ?? null, p.enquiry_text,
       p.department ?? null, p.preferred_date ?? null, patient.inserted ? "new" : "existing"],
    );
    if (!inserted) {
      // Lost a race with an identical concurrent submission.
      const winner = (await one<{ lead_id: string; correlation_id: string }>(
        c,
        `SELECT lead_id, correlation_id FROM leads WHERE idempotency_key = $1`,
        [key],
      ))!;
      return { ok: true as const, leadId: winner.lead_id, correlationId: winner.correlation_id, duplicate: true };
    }

    await audit(c, {
      workflow: "leadIntake",
      actor: "patient",
      action: "lead.received",
      recordId: leadId,
      correlationId,
      details: { source: p.source, department_requested: p.department ?? null, patient_status: patient.inserted ? "new" : "existing" },
    });
    await enqueue(c, { type: JOB.leadProcess, payload: { lead_id: leadId }, dedupeKey: `lead.process:${leadId}`, correlationId });
    return { ok: true as const, leadId, correlationId, duplicate: false };
  });
}

interface LeadRow {
  lead_id: string;
  patient_id: string;
  full_name: string;
  status: string;
  correlation_id: string;
  enquiry_text: string;
  department_requested: string | null;
  preferred_date: string | null;
  source: string;
}

async function loadDepartments(): Promise<DepartmentOption[]> {
  return many<DepartmentOption>(pool(), `SELECT department_id AS id, name FROM departments WHERE active ORDER BY name`);
}

/** Step 2 (worker job): classify, then book or route to a human. Safe to run more than once. */
export async function processLead(leadId: string): Promise<void> {
  const db = pool();
  const lead = await one<LeadRow>(
    db,
    `SELECT l.lead_id, l.patient_id, p.full_name, l.status, l.correlation_id, l.enquiry_text,
            l.department_requested, l.preferred_date, l.source
     FROM leads l JOIN patients p USING (patient_id) WHERE l.lead_id = $1`,
    [leadId],
  );
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.status !== "new") return; // Already processed.

  const departments = await loadDepartments();
  const { result, fallbackReason } = await classifyLead({
    enquiryText: lead.enquiry_text,
    departmentSelected: lead.department_requested,
    source: lead.source,
    departments,
  });

  await audit(db, {
    workflow: "leadIntake",
    // Only label the step "ai" when a model actually made the decision.
    actor: result.provider === "openai_compatible" ? "ai" : "system",
    action: "lead.classified",
    recordId: leadId,
    correlationId: lead.correlation_id,
    details: { ...result, fallback_reason: fallbackReason },
  });
  if (fallbackReason) {
    await raiseException(db, {
      workflow: "leadIntake",
      errorType: "AI_PROVIDER_DEGRADED",
      severity: "low",
      summary: "AI provider failed; rules classifier used instead. Check AI configuration and credits.",
      details: { error: fallbackReason },
      owner: "it_admin",
      // One exception per hour, not one per lead.
      dedupeKey: `ai-degraded:${new Date().toISOString().slice(0, 13)}`,
    });
  }

  const ctx = { lead, result, departments };
  if (result.emergency) return routeToHuman(ctx, "CLINICAL_EMERGENCY_MENTIONED", "high", "EMERGENCY_REDIRECT_01");
  if (result.priority_for_human_review === "review" || result.department === NEEDS_HUMAN_REVIEW) {
    return routeToHuman(ctx, "NEEDS_HUMAN_REVIEW", "medium", "ENQUIRY_ACK_01");
  }
  if (!lead.preferred_date) {
    return routeToHuman({ ...ctx, result: { ...result, missing_information: [...result.missing_information, "preferred_date"] } },
      "MISSING_PREFERRED_DATE", "medium", "ENQUIRY_ACK_01");
  }
  return bookAppointment(ctx);
}

interface Ctx {
  lead: LeadRow;
  result: LeadClassification;
  departments: DepartmentOption[];
}

function classificationColumns(result: LeadClassification) {
  return [result.department === NEEDS_HUMAN_REVIEW ? null : result.department, result.enquiry_type, result.priority_for_human_review, result];
}

async function routeToHuman(
  { lead, result }: Ctx,
  errorType: string,
  severity: "medium" | "high",
  template: "ENQUIRY_ACK_01" | "EMERGENCY_REDIRECT_01",
): Promise<void> {
  await tx(async (c) => {
    const updated = await c.query(
      `UPDATE leads SET status = 'needs_review', department = $2, enquiry_type = $3, priority = 'review',
                        ai_result = $4, owner = 'front_desk', updated_at = now()
       WHERE lead_id = $1 AND status = 'new'`,
      [lead.lead_id, result.department === NEEDS_HUMAN_REVIEW ? null : result.department, result.enquiry_type, result],
    );
    if (!updated.rowCount) return; // Another worker got here first.

    await raiseException(c, {
      workflow: "leadIntake",
      errorType,
      severity,
      summary:
        errorType === "CLINICAL_EMERGENCY_MENTIONED"
          ? `Possible emergency described by ${lead.full_name}. Call the patient now.`
          : `Enquiry from ${lead.full_name} needs a person: ${result.reason}`,
      recordId: lead.lead_id,
      correlationId: lead.correlation_id,
      details: { safety_flags: result.safety_flags, missing_information: result.missing_information, enquiry_type: result.enquiry_type },
      dedupeKey: `lead-review:${lead.lead_id}`,
    });
    await audit(c, {
      workflow: "leadIntake",
      actor: "system",
      action: "lead.routed_to_human",
      recordId: lead.lead_id,
      correlationId: lead.correlation_id,
      details: { reason: errorType },
    });
    await enqueueLeadMessage(c, lead, template);
  });
}

async function enqueueLeadMessage(c: Parameters<typeof enqueue>[0], lead: LeadRow, template: "ENQUIRY_ACK_01" | "EMERGENCY_REDIRECT_01") {
  const e = env();
  const dedupeKey = `msg:${lead.lead_id}:${template}`;
  await enqueue(c, {
    type: JOB.messageSend,
    payload: {
      dedupe_key: dedupeKey,
      patient_id: lead.patient_id,
      template,
      workflow: "leadIntake",
      lead_id: lead.lead_id,
      vars: { patient_name: lead.full_name, hospital_name: e.HOSPITAL_NAME, emergency_number: e.EMERGENCY_NUMBER },
    },
    dedupeKey: `job:${dedupeKey}`,
    correlationId: lead.correlation_id,
  });
}

interface SlotRow {
  slot_id: string;
  doctor_id: string;
  slot_start: Date;
  slot_end: Date;
}

async function bookAppointment({ lead, result }: Ctx): Promise<void> {
  const department = result.department;
  const [dayStart, dayEnd] = istDayRange(lead.preferred_date!);

  await tx(async (c) => {
    // Lock the lead so two workers can never book it twice.
    const locked = await one<{ status: string }>(c, `SELECT status FROM leads WHERE lead_id = $1 FOR UPDATE`, [lead.lead_id]);
    if (locked?.status !== "new") return;

    // Earliest open slot that day. SKIP LOCKED lets concurrent bookings take different slots.
    const slot = await one<SlotRow>(
      c,
      `SELECT s.slot_id, s.doctor_id, s.slot_start, s.slot_end
       FROM slots s JOIN doctors d USING (doctor_id)
       WHERE s.department_id = $1 AND s.status = 'open' AND d.active
         AND s.slot_start >= $2 AND s.slot_start < $3
         AND s.slot_start > now() + make_interval(mins => $4)
       ORDER BY s.slot_start, s.doctor_id
       LIMIT 1
       FOR UPDATE OF s SKIP LOCKED`,
      [department, dayStart, dayEnd, MIN_LEAD_TIME_MINUTES],
    );

    if (!slot) {
      const alternatives = await many<{ slot_start: Date; doctor_id: string }>(
        c,
        `SELECT slot_start, doctor_id FROM slots
         WHERE department_id = $1 AND status = 'open' AND slot_start > now() + make_interval(mins => $2)
         ORDER BY slot_start LIMIT 3`,
        [department, MIN_LEAD_TIME_MINUTES],
      );
      await c.query(
        `UPDATE leads SET status = 'no_slot', department = $2, enquiry_type = $3, priority = $4, ai_result = $5,
                          owner = 'front_desk', updated_at = now()
         WHERE lead_id = $1`,
        [lead.lead_id, ...classificationColumns(result)],
      );
      await raiseException(c, {
        workflow: "appointment",
        errorType: "NO_SLOT_AVAILABLE",
        severity: "medium",
        summary: `No ${department} slot on ${lead.preferred_date} for ${lead.full_name}. Offer an alternative.`,
        recordId: lead.lead_id,
        correlationId: lead.correlation_id,
        details: { preferred_date: lead.preferred_date, alternatives },
        dedupeKey: `no-slot:${lead.lead_id}`,
      });
      await audit(c, {
        workflow: "appointment",
        actor: "system",
        action: "appointment.no_slot",
        recordId: lead.lead_id,
        correlationId: lead.correlation_id,
        details: { department, preferred_date: lead.preferred_date, alternatives_found: alternatives.length },
      });
      await enqueueLeadMessage(c, lead, "ENQUIRY_ACK_01");
      return;
    }

    const appointmentId = newId("APT");
    await c.query(
      `INSERT INTO appointments (appointment_id, patient_id, lead_id, department_id, doctor_id, slot_id,
                                 slot_start, slot_end, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [appointmentId, lead.patient_id, lead.lead_id, department, slot.doctor_id, slot.slot_id, slot.slot_start, slot.slot_end, lead.correlation_id],
    );
    await c.query(`UPDATE slots SET status = 'booked', appointment_id = $2 WHERE slot_id = $1`, [slot.slot_id, appointmentId]);
    await c.query(
      `UPDATE leads SET status = 'booked', department = $2, enquiry_type = $3, priority = $4, ai_result = $5,
                        appointment_id = $6, updated_at = now()
       WHERE lead_id = $1`,
      [lead.lead_id, ...classificationColumns(result), appointmentId],
    );
    await audit(c, {
      workflow: "appointment",
      actor: "system",
      action: "appointment.booked",
      recordId: appointmentId,
      correlationId: lead.correlation_id,
      details: { lead_id: lead.lead_id, doctor_id: slot.doctor_id, slot_start: slot.slot_start },
    });

    await enqueue(c, {
      type: JOB.appointmentConfirm,
      payload: { appointment_id: appointmentId },
      dedupeKey: `appointment.confirm:${appointmentId}`,
      correlationId: lead.correlation_id,
    });
    await scheduleReminders(c, appointmentId, slot.slot_start, lead.correlation_id);
  });
}

export const REMINDER_STAGES = [
  { stage: "24h", hoursBefore: 24 },
  { stage: "3h", hoursBefore: 3 },
] as const;

/** Queues reminders that are still in the future. Keyed by slot time, so a reschedule gets fresh reminders. */
export async function scheduleReminders(c: Parameters<typeof enqueue>[0], appointmentId: string, slotStart: Date, correlationId: string) {
  const now = Date.now();
  for (const { stage, hoursBefore } of REMINDER_STAGES) {
    const runAt = new Date(slotStart.getTime() - hoursBefore * 3600_000);
    // Skip a reminder that would fire within 10 minutes of booking; the confirmation covers it.
    if (runAt.getTime() < now + 10 * 60_000) continue;
    await enqueue(c, {
      type: JOB.appointmentReminder,
      payload: { appointment_id: appointmentId, stage, slot_start: slotStart.toISOString() },
      runAt,
      dedupeKey: `appointment.reminder:${appointmentId}:${slotStart.toISOString()}:${stage}`,
      correlationId,
    });
  }
}
