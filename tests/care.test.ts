import { beforeEach, describe, expect, it } from "vitest";
import { many, one, pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { addDays, istDateString } from "@/lib/time";
import { createStaffUser } from "@/server/auth/users";
import { careStats, conditionsIn, recordCareVisit, sweepCare } from "@/server/care/care";
import { handleHmsEvent } from "@/server/care/hms";
import { listLabs, markReportReady, markReviewed, recordLab, sweepLabs } from "@/server/care/labs";
import { finaliseConsultation, type Actor } from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import { createVisit, startConsultation } from "@/server/clinic/visits";
import { drain } from "@/worker/runner";
import { seed } from "../scripts/seed";
import { resetData } from "./helpers";

let doctor: Actor;
let seq = 0;

async function patient(name = "Lakshmi Reddy") {
  const r = await registerPatient(pool(), { full_name: name, phone: `97000${String(10000 + ++seq).slice(-5)}`, gender: "female", age: "52", whatsapp_consent: "yes" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.patient;
}

const messages = (template: string) =>
  many<{ body: string; recipient: string }>(pool(), `SELECT body, recipient FROM communication_log WHERE template_name = $1 ORDER BY created_at`, [template]);

beforeEach(async () => {
  await resetData();
  await seed(process.env.DATABASE_URL!, { days: 1, quiet: true });
  const u = await createStaffUser(pool(), { email: "rao@h.com", fullName: "Dr Rao", role: "doctor", doctorId: "DOC-CAR-1", password: "correct horse battery" });
  doctor = { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
});

describe("chronic conditions in a diagnosis", () => {
  it("recognises the common ways doctors write them", () => {
    expect(conditionsIn("Type 2 diabetes mellitus")).toEqual(["diabetes"]);
    expect(conditionsIn("T2DM with HTN")).toEqual(["diabetes", "hypertension"]);
    expect(conditionsIn("Hypothyroidism, on levothyroxine")).toEqual(["thyroid"]);
    expect(conditionsIn("Viral fever")).toEqual([]);
    expect(conditionsIn(null)).toEqual([]);
  });

  it("is visible to the desk and doctors, managed by the desk, reviewed by doctors", () => {
    expect(can("receptionist", "care.manage")).toBe(true);
    expect(can("doctor", "labs.review")).toBe(true);
    expect(can("receptionist", "labs.review")).toBe(false);
    expect(can("pharmacist", "care.view")).toBe(false);
  });
});

describe("care recall", () => {
  it("enrols a patient when the doctor finishes a consultation with a chronic diagnosis", async () => {
    const p = await patient();
    const { visit } = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
    await startConsultation(visit.visit_id);
    const r = await finaliseConsultation(doctor, visit.visit_id, { chief_complaint: "Thirst", diagnosis: "Type 2 diabetes mellitus", items: [] });
    expect(r.ok).toBe(true);
    const plan = await one<{ condition: string; next_due_date: string }>(pool(), `SELECT condition, next_due_date::text FROM care_plans WHERE patient_id = $1`, [p.patient_id]);
    expect(plan).toEqual({ condition: "diabetes", next_due_date: addDays(istDateString(), 90) });
  });

  it("reminds before the due date, again after a missed week, then asks the desk to call", async () => {
    const p = await patient();
    const today = istDateString();
    // Due in two days: first reminder now.
    await recordCareVisit(pool(), { patientId: p.patient_id, condition: "diabetes", visitDate: addDays(today, -88) });
    expect(await sweepCare(today)).toEqual({ reminded: 1, escalated: 0 });
    expect(await sweepCare(today)).toEqual({ reminded: 0, escalated: 0 }); // nothing twice
    const [msg] = await messages("CARE_RECALL_01");
    expect(msg!.body).toContain("diabetes check-up");

    // Eight days after the due date: the second reminder.
    expect((await sweepCare(addDays(today, 10))).reminded).toBe(1);
    // Fifteen days overdue after two reminders: a person calls.
    expect(await sweepCare(addDays(today, 17))).toMatchObject({ escalated: 1 });
    const exc = await one<{ error_type: string; owner: string }>(pool(), `SELECT error_type, owner FROM exceptions WHERE error_type = 'CARE_OVERDUE'`);
    expect(exc).toEqual({ error_type: "CARE_OVERDUE", owner: "front_desk" });
  });

  it("restarts the clock when the patient comes back, and never moves it backwards", async () => {
    const p = await patient();
    const today = istDateString();
    await recordCareVisit(pool(), { patientId: p.patient_id, condition: "hypertension", visitDate: addDays(today, -95) });
    await sweepCare(today);
    const back = await recordCareVisit(pool(), { patientId: p.patient_id, condition: "hypertension", visitDate: today });
    expect(back.enrolled).toBe(false);
    await recordCareVisit(pool(), { patientId: p.patient_id, condition: "hypertension", visitDate: addDays(today, -200) });
    const plan = await one<{ next_due_date: string; reminders_sent: number }>(pool(), `SELECT next_due_date::text, reminders_sent FROM care_plans WHERE patient_id = $1`, [p.patient_id]);
    expect(plan).toEqual({ next_due_date: addDays(today, 90), reminders_sent: 0 });
    expect((await careStats(pool())).enrolled).toBe(1);
  });
});

describe("lab follow-ups", () => {
  it("tells the patient when a report is ready and chases an unreviewed one", async () => {
    const p = await patient();
    const { diagnosticId } = await recordLab({ patientId: p.patient_id, testName: "HbA1c", externalId: "LIS-1" });
    expect((await listLabs(pool(), "waiting")).map((l) => l.diagnostic_id)).toEqual([diagnosticId]);

    const nurse = await createStaffUser(pool(), { email: "n@h.com", fullName: "Nurse", role: "nurse", password: "correct horse battery" });
    await markReportReady(nurse.user_id, diagnosticId, "normal");
    await drain();
    const [msg] = await messages("LAB_REPORT_READY_01");
    expect(msg!.body).toContain("HbA1c report");
    expect((await listLabs(pool(), "review"))[0]).toMatchObject({ diagnostic_id: diagnosticId, notification_status: "sent" });

    await pool().query(`UPDATE diagnostic_tasks SET report_ready_at = now() - interval '30 hours' WHERE diagnostic_id = $1`, [diagnosticId]);
    expect(await sweepLabs()).toBe(1);
    expect(await sweepLabs()).toBe(0);

    await markReviewed(doctor.user_id, diagnosticId);
    const open = await one<{ n: number }>(pool(), `SELECT count(*)::int AS n FROM exceptions WHERE record_id = $1 AND status = 'open'`, [diagnosticId]);
    expect(open!.n).toBe(0);
    await expect(markReviewed(doctor.user_id, diagnosticId)).rejects.toThrow();
  });

  it("sends an abnormal result to the doctor straight away", async () => {
    const p = await patient();
    const { diagnosticId } = await recordLab({ patientId: p.patient_id, testName: "Serum creatinine", readyAt: new Date(), flag: "abnormal" });
    const exc = await one<{ severity: string; owner: string }>(pool(), `SELECT severity, owner FROM exceptions WHERE record_id = $1`, [diagnosticId]);
    expect(exc).toEqual({ severity: "high", owner: "doctor" });
  });
});

describe("events from the hospital's HMS", () => {
  const who = { name: "Venkat Rao", phone: "98480 12345", whatsapp_consent: true };

  it("enrols from a visit and follows up a lab result, without duplicates", async () => {
    const v = await handleHmsEvent({ event: "visit", patient: who, diagnosis: "T2DM, HTN", visit_date: istDateString() });
    expect(v.ok).toBe(true);
    const plans = await many<{ condition: string; source: string }>(pool(), `SELECT condition, source FROM care_plans ORDER BY condition`);
    expect(plans).toEqual([{ condition: "diabetes", source: "hms" }, { condition: "hypertension", source: "hms" }]);

    await handleHmsEvent({ event: "lab_ordered", patient: who, test_name: "Lipid profile", external_id: "LIS-77" });
    await handleHmsEvent({ event: "lab_result", patient: who, test_name: "Lipid profile", external_id: "LIS-77", flag: "normal" });
    await handleHmsEvent({ event: "lab_result", patient: who, test_name: "Lipid profile", external_id: "LIS-77", flag: "normal" });
    const labs = await many(pool(), `SELECT 1 FROM diagnostic_tasks`);
    expect(labs).toHaveLength(1);
    await drain();
    expect(await messages("LAB_REPORT_READY_01")).toHaveLength(1);
  });

  it("rejects a bad event without touching anything", async () => {
    const r = await handleHmsEvent({ event: "visit", patient: { name: "X", phone: "12" } });
    expect(r.ok).toBe(false);
    const n = await one<{ n: number }>(pool(), `SELECT count(*)::int AS n FROM patients`);
    expect(n!.n).toBe(0);
  });
});
