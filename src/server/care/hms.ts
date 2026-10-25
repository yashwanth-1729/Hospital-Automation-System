import { z } from "zod";
import { audit } from "@/lib/audit";
import { one, pool } from "@/lib/db";
import { newId } from "@/lib/ids";
import { normalizeIndianPhone } from "@/lib/phone";
import { isValidDateString, istDateString } from "@/lib/time";
import { conditionsIn, isCondition, recordCareVisit, type Condition } from "./care";
import { recordLab } from "./labs";

/**
 * Events from a hospital's existing HMS or lab system. This is how Clevo sits on top of the
 * software a hospital already uses: the HMS reports what happened, Clevo does the follow-up.
 *
 *   POST /api/webhooks/hms   (header x-webhook-secret)
 *   { "event": "visit", "patient": {...}, "diagnosis": "Type 2 diabetes", "visit_date": "2026-10-26" }
 *   { "event": "lab_ordered", "patient": {...}, "test_name": "HbA1c", "external_id": "LIS-991" }
 *   { "event": "lab_result", "patient": {...}, "test_name": "HbA1c", "external_id": "LIS-991", "flag": "abnormal" }
 */

const Patient = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(10).max(20),
  // The hospital confirms the patient agreed to WhatsApp messages when they registered.
  whatsapp_consent: z.boolean().default(false),
});

const Visit = z.object({
  event: z.literal("visit"),
  patient: Patient,
  diagnosis: z.string().trim().max(500).optional(),
  conditions: z.array(z.string()).max(3).optional(),
  visit_date: z.string().refine(isValidDateString, "visit_date must be YYYY-MM-DD").optional(),
});

const Lab = z.object({
  event: z.enum(["lab_ordered", "lab_result"]),
  patient: Patient,
  test_name: z.string().trim().min(2).max(120),
  external_id: z.string().trim().min(1).max(80),
  doctor_name: z.string().trim().max(120).optional(),
  flag: z.enum(["normal", "abnormal"]).optional(),
});

export const HmsEvent = z.discriminatedUnion("event", [Visit, Lab]);

export type HmsResult =
  | { ok: true; event: string; patient_id: string; detail: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

async function patientFor(p: z.infer<typeof Patient>): Promise<string | null> {
  const phone = normalizeIndianPhone(p.phone);
  if (!phone) return null;
  const row = await one<{ patient_id: string }>(
    pool(),
    `INSERT INTO patients (patient_id, full_name, phone, source, consent_status)
     VALUES ($1, $2, $3, 'hms', $4)
     ON CONFLICT (phone) DO UPDATE SET
       consent_status = CASE WHEN $4 = 'granted' THEN 'granted' ELSE patients.consent_status END,
       updated_at = now()
     RETURNING patient_id`,
    [newId("PAT"), p.name, phone, p.whatsapp_consent ? "granted" : "unknown"],
  );
  return row!.patient_id;
}

export async function handleHmsEvent(raw: unknown): Promise<HmsResult> {
  const parsed = HmsEvent.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[i.path.join(".") || "_"] ??= i.message;
    return { ok: false, errors };
  }
  const ev = parsed.data;
  const patientId = await patientFor(ev.patient);
  if (!patientId) return { ok: false, errors: { "patient.phone": "Not a valid Indian mobile number." } };

  if (ev.event === "visit") {
    const named = (ev.conditions ?? []).filter(isCondition) as Condition[];
    const found = [...new Set([...named, ...conditionsIn(ev.diagnosis)])];
    const visitDate = ev.visit_date ?? istDateString();
    const plans = [];
    for (const condition of found) plans.push({ condition, ...(await recordCareVisit(pool(), { patientId, condition, visitDate, source: "hms" })) });
    await audit(pool(), { workflow: "clinic", actor: "system", action: "hms.visit", recordId: patientId, details: { conditions: found } });
    return { ok: true, event: ev.event, patient_id: patientId, detail: { care_plans: plans } };
  }

  const r = await recordLab({
    patientId,
    testName: ev.test_name,
    doctorName: ev.doctor_name ?? null,
    readyAt: ev.event === "lab_result" ? new Date() : null,
    flag: ev.flag ?? null,
    externalId: `hms:${ev.external_id}`,
    source: "hms",
  });
  return { ok: true, event: ev.event, patient_id: patientId, detail: { diagnostic_id: r.diagnosticId, report_ready: r.ready } };
}
