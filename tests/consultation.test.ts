import { beforeEach, describe, expect, it } from "vitest";
import { many, one, pool } from "@/lib/db";
import { allergens, allergyConflicts, bmi, quantityFor } from "@/lib/prescribing";
import { addDays, istDateString } from "@/lib/time";
import {
  addAddendum,
  ConsultError,
  finaliseConsultation,
  getConsultationForVisit,
  patientHistory,
  recordVitals,
  saveDraft,
  searchFormulary,
  sendConsultFollowupReminder,
  visitVitals,
  type Actor,
} from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import { createVisit, startConsultation } from "@/server/clinic/visits";
import { createStaffUser } from "@/server/auth/users";
import { seed } from "../scripts/seed";
import { q, resetData } from "./helpers";

const PASSWORD = "correct horse battery";
let doctor: Actor;
let otherDoctor: Actor;
let nurse: Actor;
let receptionist: Actor;

async function staff(email: string, role: "doctor" | "nurse" | "receptionist", doctorId?: string): Promise<Actor> {
  const u = await createStaffUser(pool(), { email, fullName: `Staff ${email}`, role, doctorId, password: PASSWORD });
  return { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
}

async function patient(opts: { name?: string; phone?: string; allergies?: string } = {}) {
  const r = await registerPatient(pool(), {
    full_name: opts.name ?? "Meera Iyer",
    phone: opts.phone ?? "98765 43210",
    gender: "female",
    age: "34",
    allergies: opts.allergies,
    whatsapp_consent: "yes",
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.patient;
}

/** A patient who has been called in to the main doctor. */
async function inConsultation(opts: Parameters<typeof patient>[0] = {}) {
  const p = await patient(opts);
  const { visit } = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
  await startConsultation(visit.visit_id);
  return { p, visit };
}

const paracetamol = { medicine_name: "Paracetamol 500 mg", dose_units: 1, frequency: "TDS", duration_days: 5, timing: "after_food" };
const goodSheet = { chief_complaint: "Fever for two days", diagnosis: "Viral fever", advice: "Rest and fluids", items: [paracetamol] };

beforeEach(async () => {
  await resetData();
  await seed(process.env.DATABASE_URL!, { days: 1, quiet: true });
  doctor = await staff("rao@h.com", "doctor", "DOC-CAR-1");
  otherDoctor = await staff("menon@h.com", "doctor", "DOC-CAR-2");
  nurse = await staff("nurse@h.com", "nurse");
  receptionist = await staff("desk@h.com", "receptionist");
});

describe("prescribing rules", () => {
  it("computes quantity from dose, frequency and days, rounding up", () => {
    expect(quantityFor({ doseUnits: 1, frequency: "TDS", durationDays: 5 })).toBe(15);
    expect(quantityFor({ doseUnits: 0.5, frequency: "BD", durationDays: 5 })).toBe(5);
    expect(quantityFor({ doseUnits: 2.5, frequency: "OD", durationDays: 3 })).toBe(8);
    expect(quantityFor({ doseUnits: 5, frequency: "TDS", durationDays: 5 })).toBe(75);
  });

  it("needs a stated quantity when the schedule is only-if-needed", () => {
    expect(quantityFor({ doseUnits: 1, frequency: "SOS", durationDays: 5 })).toBe(0);
    expect(quantityFor({ doseUnits: 1, frequency: "SOS", durationDays: 5, explicit: 10 })).toBe(10);
  });

  it("reads allergens out of free text and ignores 'none'", () => {
    expect(allergens("Penicillin, sulfa; and egg")).toEqual(["penicillin", "sulfa", "egg"]);
    expect(allergens("None")).toEqual([]);
    expect(allergens("NKDA")).toEqual([]);
    expect(allergens(null)).toEqual([]);
  });

  it("flags a drug of the class a patient is allergic to, not only the exact name", () => {
    const items = [{ medicine_name: "Amoxicillin 500 mg" }, { medicine_name: "Paracetamol 500 mg" }, { medicine_name: "Diclofenac 50 mg" }];
    expect(allergyConflicts("Penicillin", items).map((c) => c.medicine)).toEqual(["Amoxicillin 500 mg"]);
    expect(allergyConflicts("NSAIDs", items).map((c) => c.medicine)).toEqual(["Diclofenac 50 mg"]);
    expect(allergyConflicts("pollen", items)).toEqual([]);
    expect(allergyConflicts(null, items)).toEqual([]);
  });

  it("matches on the generic name when the brand name hides it", () => {
    expect(allergyConflicts("amoxicillin", [{ medicine_name: "Novamox", generic_name: "Amoxicillin" }])).toHaveLength(1);
  });

  it("computes BMI and refuses implausible inputs", () => {
    expect(bmi(70, 175)).toBe(22.9);
    expect(bmi(null, 175)).toBeNull();
    expect(bmi(70, 10)).toBeNull();
  });
});

describe("vitals", () => {
  it("lets a nurse record vitals while the patient is still waiting", async () => {
    const p = await patient();
    const { visit } = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
    const r = await recordVitals(nurse, visit.visit_id, { bp_systolic: "128", bp_diastolic: "82", pulse: "76", temperature_c: "37.2", weight_kg: "62" });
    expect(r.ok).toBe(true);
    const rows = await visitVitals(pool(), visit.visit_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bp_systolic: 128, bp_diastolic: 82, pulse: 76, temperature_c: 37.2, weight_kg: 62 });
  });

  it("rejects readings that cannot be right, saying which", async () => {
    const { visit } = await inConsultation();
    const r = await recordVitals(nurse, visit.visit_id, { pulse: "900", temperature_c: "98.6" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["pulse", "temperature_c"]);
  });

  it("requires a complete, sensible blood pressure", async () => {
    const { visit } = await inConsultation();
    const half = await recordVitals(nurse, visit.visit_id, { bp_systolic: "120" });
    expect(!half.ok && half.errors.bp_diastolic).toBeTruthy();
    const inverted = await recordVitals(nurse, visit.visit_id, { bp_systolic: "80", bp_diastolic: "120" });
    expect(!inverted.ok && inverted.errors.bp_diastolic).toBeTruthy();
  });

  it("refuses an empty form", async () => {
    const { visit } = await inConsultation();
    const r = await recordVitals(nurse, visit.visit_id, {});
    expect(!r.ok && r.errors._).toBeTruthy();
  });

  it("keeps a doctor to their own patients and a receptionist out entirely", async () => {
    const { visit } = await inConsultation();
    await expect(recordVitals(otherDoctor, visit.visit_id, { pulse: "70" })).rejects.toMatchObject({ code: "not_your_patient" });
    await expect(recordVitals(receptionist, visit.visit_id, { pulse: "70" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await recordVitals(doctor, visit.visit_id, { pulse: "70" })).ok).toBe(true);
  });

  it("keeps every reading, newest first", async () => {
    const { visit } = await inConsultation();
    await recordVitals(nurse, visit.visit_id, { pulse: "90" });
    await recordVitals(nurse, visit.visit_id, { pulse: "80" });
    expect((await visitVitals(pool(), visit.visit_id)).map((v) => v.pulse)).toEqual([80, 90]);
  });
});

describe("writing the consultation", () => {
  it("cannot start before the patient is called in", async () => {
    const p = await patient();
    const { visit } = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
    await expect(saveDraft(doctor, visit.visit_id, goodSheet)).rejects.toMatchObject({ code: "not_in_consultation" });
  });

  it("belongs to the treating doctor alone", async () => {
    const { visit } = await inConsultation();
    await expect(saveDraft(otherDoctor, visit.visit_id, goodSheet)).rejects.toMatchObject({ code: "not_your_patient" });
    await expect(saveDraft(nurse, visit.visit_id, goodSheet)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("saves and re-saves a draft, replacing the medicines", async () => {
    const { visit } = await inConsultation();
    await saveDraft(doctor, visit.visit_id, { chief_complaint: "Cough", items: [paracetamol] });
    await saveDraft(doctor, visit.visit_id, {
      chief_complaint: "Cough and fever",
      items: [{ ...paracetamol, medicine_name: "Cetirizine 10 mg", frequency: "OD", duration_days: 3 }, { medicine_name: "" }],
    });
    const c = await getConsultationForVisit(pool(), visit.visit_id);
    expect(c!.status).toBe("draft");
    expect(c!.chief_complaint).toBe("Cough and fever");
    expect(c!.items.map((i) => [i.medicine_name, i.quantity])).toEqual([["Cetirizine 10 mg", 3]]);
  });

  it("points at the exact field that is wrong", async () => {
    const { visit } = await inConsultation();
    const r = await saveDraft(doctor, visit.visit_id, { items: [{ medicine_name: "Paracetamol 500 mg", dose_units: 1, frequency: "XX" as never, duration_days: 0 }] });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors!)).toEqual(expect.arrayContaining(["items.0.frequency", "items.0.duration_days"]));
  });

  it("links a typed name to the formulary", async () => {
    const { visit } = await inConsultation();
    await saveDraft(doctor, visit.visit_id, { items: [{ ...paracetamol, medicine_name: "paracetamol 500 MG" }] });
    const c = await getConsultationForVisit(pool(), visit.visit_id);
    expect(c!.items[0]!.medicine_id).toMatch(/^MED-/);
  });

  it("keeps a medicine the formulary does not know, as written", async () => {
    const { visit } = await inConsultation();
    await saveDraft(doctor, visit.visit_id, { items: [{ ...paracetamol, medicine_name: "Compounded cream, 2 percent" }] });
    const c = await getConsultationForVisit(pool(), visit.visit_id);
    expect(c!.items[0]).toMatchObject({ medicine_id: null, medicine_name: "Compounded cream, 2 percent" });
  });

  it("searches the formulary by brand or generic name", async () => {
    expect((await searchFormulary(pool(), "paracet")).length).toBeGreaterThan(0);
    expect((await searchFormulary(pool(), "clavulanic")).some((m) => m.name.startsWith("Amoxicillin"))).toBe(true);
    // A wildcard typed by a person is plain text: only names that contain a literal % match.
    expect(await searchFormulary(pool(), "_")).toEqual([]);
    const percent = await searchFormulary(pool(), "%");
    expect(percent.length).toBeGreaterThan(0);
    expect(percent.every((m) => m.name.includes("%"))).toBe(true);
  });
});

describe("finishing the consultation", () => {
  it("needs a complaint and a diagnosis", async () => {
    const { visit } = await inConsultation();
    const r = await finaliseConsultation(doctor, visit.visit_id, { items: [paracetamol] });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors!)).toEqual(expect.arrayContaining(["diagnosis", "chief_complaint"]));
    expect((await one<{ status: string }>(pool(), `SELECT status FROM visits WHERE visit_id = $1`, [visit.visit_id]))!.status).toBe("in_consultation");
  });

  it("locks the record, issues the prescription, frees the doctor and queues the patient message", async () => {
    const { visit } = await inConsultation();
    const r = await finaliseConsultation(doctor, visit.visit_id, goodSheet);
    expect(r.ok).toBe(true);

    const c = await getConsultationForVisit(pool(), visit.visit_id);
    expect(c).toMatchObject({ status: "final", diagnosis: "Viral fever", prescription_status: "issued" });
    expect(c!.items[0]).toMatchObject({ quantity: 15, dispensed_qty: 0 });
    expect((await one<{ status: string }>(pool(), `SELECT status FROM visits WHERE visit_id = $1`, [visit.visit_id]))!.status).toBe("completed");

    const jobs = await q.jobs("message.send");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.template).toBe("CONSULT_COMPLETE_01");
    expect(jobs[0]!.payload.vars.next_step).toMatch(/pharmacy/i);
  });

  it("is final: no further edits, only addenda from the treating doctor", async () => {
    const { visit } = await inConsultation();
    await finaliseConsultation(doctor, visit.visit_id, goodSheet);
    await expect(saveDraft(doctor, visit.visit_id, goodSheet)).rejects.toMatchObject({ code: "not_in_consultation" });

    const c = await getConsultationForVisit(pool(), visit.visit_id);
    await addAddendum(doctor, c!.consultation_id, "Patient called: rash after the first dose. Stop and review.");
    await expect(addAddendum(otherDoctor, c!.consultation_id, "x")).rejects.toMatchObject({ code: "not_your_patient" });
    await expect(addAddendum(nurse, c!.consultation_id, "x")).rejects.toMatchObject({ code: "forbidden" });

    const after = await getConsultationForVisit(pool(), visit.visit_id);
    expect(after!.addenda).toHaveLength(1);
    expect(after!.diagnosis).toBe("Viral fever"); // the original is untouched
  });

  it("finishes without a prescription when no medicines are given", async () => {
    const { visit } = await inConsultation();
    await finaliseConsultation(doctor, visit.visit_id, { chief_complaint: "Review", diagnosis: "Healthy" });
    expect(await many(pool(), `SELECT 1 FROM prescriptions`)).toHaveLength(0);
    expect((await q.jobs("message.send"))[0]!.payload.vars.next_step).toMatch(/no medicines/i);
  });

  it("is safe to submit twice", async () => {
    const { visit } = await inConsultation();
    await finaliseConsultation(doctor, visit.visit_id, goodSheet);
    await expect(finaliseConsultation(doctor, visit.visit_id, goodSheet)).rejects.toBeInstanceOf(ConsultError);
    expect(await q.jobs("message.send")).toHaveLength(1);
    expect(await many(pool(), `SELECT 1 FROM prescriptions`)).toHaveLength(1);
  });

  it("rejects the same medicine listed twice", async () => {
    const { visit } = await inConsultation();
    const r = await finaliseConsultation(doctor, visit.visit_id, { ...goodSheet, items: [paracetamol, { ...paracetamol, duration_days: 3 }] });
    expect(r.ok).toBe(false);
    expect(r.errors!._).toMatch(/twice/);
  });

  it("schedules a reminder for a follow-up date and refuses a past one", async () => {
    const { visit } = await inConsultation();
    const past = await finaliseConsultation(doctor, visit.visit_id, { ...goodSheet, follow_up_date: istDateString() });
    expect(past.ok).toBe(false);
    expect(past.errors!.follow_up_date).toBeTruthy();

    const date = addDays(istDateString(), 7);
    const ok = await finaliseConsultation(doctor, visit.visit_id, { ...goodSheet, follow_up_date: date });
    expect(ok.ok).toBe(true);
    const reminders = await q.jobs("consult.followup_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.payload.followup_date).toBe(date);
  });
});

describe("allergy safety net", () => {
  const amoxicillin = { medicine_name: "Amoxicillin 500 mg", dose_units: 1, frequency: "TDS", duration_days: 5, timing: "after_food" };

  it("stops a penicillin-class drug for an allergic patient until the doctor gives a reason", async () => {
    const { visit } = await inConsultation({ allergies: "Penicillin" });
    const blocked = await finaliseConsultation(doctor, visit.visit_id, { ...goodSheet, items: [amoxicillin] });
    expect(blocked.ok).toBe(false);
    expect(blocked.conflicts).toHaveLength(1);
    expect(blocked.errors!.allergy_override_reason).toBeTruthy();
    expect((await getConsultationForVisit(pool(), visit.visit_id))?.status).not.toBe("final");
  });

  it("lets the doctor proceed on a stated reason, and keeps the reason on the prescription", async () => {
    const { visit } = await inConsultation({ allergies: "Penicillin" });
    const r = await finaliseConsultation(doctor, visit.visit_id, {
      ...goodSheet,
      items: [amoxicillin],
      allergy_override_reason: "Tolerated amoxicillin in 2023; reaction was to benzylpenicillin.",
    });
    expect(r.ok).toBe(true);
    const c = await getConsultationForVisit(pool(), visit.visit_id);
    expect(c!.allergy_override_reason).toMatch(/tolerated/i);
    const audit = await many<{ details: { allergy_override: boolean } }>(pool(), `SELECT details FROM audit_log WHERE action = 'consultation.finalised'`);
    expect(audit[0]!.details.allergy_override).toBe(true);
  });

  it("does not flag unrelated medicines", async () => {
    const { visit } = await inConsultation({ allergies: "Penicillin" });
    expect((await finaliseConsultation(doctor, visit.visit_id, goodSheet)).ok).toBe(true);
  });

  it("warns on a draft too, without blocking the save", async () => {
    const { visit } = await inConsultation({ allergies: "Penicillin" });
    const r = await saveDraft(doctor, visit.visit_id, { items: [amoxicillin] });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toHaveLength(1);
  });
});

describe("history and reminders", () => {
  it("returns earlier finished consultations, newest first, excluding the current visit", async () => {
    const p = await patient();
    const first = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
    await startConsultation(first.visit.visit_id);
    await finaliseConsultation(doctor, first.visit.visit_id, { ...goodSheet, diagnosis: "Viral fever" });
    await pool().query(`UPDATE visits SET visit_date = visit_date - 30 WHERE visit_id = $1`, [first.visit.visit_id]);

    const second = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
    await startConsultation(second.visit.visit_id);

    const history = await patientHistory(pool(), p.patient_id, { excludeVisitId: second.visit.visit_id });
    expect(history.map((h) => h.diagnosis)).toEqual(["Viral fever"]);
    expect(history[0]!.items).toHaveLength(1);
  });

  it("sends the follow-up reminder once, and not if the date has since changed", async () => {
    const { p, visit } = await inConsultation();
    const date = addDays(istDateString(), 7);
    await finaliseConsultation(doctor, visit.visit_id, { ...goodSheet, follow_up_date: date });
    const consultationId = (await getConsultationForVisit(pool(), visit.visit_id))!.consultation_id;

    await sendConsultFollowupReminder(consultationId, date);
    await sendConsultFollowupReminder(consultationId, date);
    let msgs = (await q.messages()).filter((m) => m.template_name === "FOLLOWUP_REMINDER_01");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.patient_id).toBe(p.patient_id);

    await pool().query(`UPDATE consultations SET follow_up_date = $2 WHERE consultation_id = $1`, [consultationId, addDays(date, 3)]);
    await sendConsultFollowupReminder(consultationId, date);
    msgs = (await q.messages()).filter((m) => m.template_name === "FOLLOWUP_REMINDER_01");
    expect(msgs).toHaveLength(1);
  });
});
