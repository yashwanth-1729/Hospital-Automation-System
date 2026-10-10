import { beforeEach, describe, expect, it } from "vitest";
import { ageInYears, estimatedDateOfBirth, formatAge } from "@/lib/age";
import { many, one, pool } from "@/lib/db";
import { newCorrelationId, newId } from "@/lib/ids";
import { addDays, istDateString } from "@/lib/time";
import { registerPatient, searchPatients } from "@/server/clinic/patients";
import {
  cancelVisit,
  checkInAppointment,
  completeVisit,
  createVisit,
  listExpectedToday,
  listQueue,
  queueSummary,
  setVisitPriority,
  startConsultation,
  VisitError,
} from "@/server/clinic/visits";
import { addSlot, resetData } from "./helpers";

const DOCTOR = "DOC-CAR-1";
const OTHER_DOCTOR = "DOC-DER-1";

async function patient(name = "Meera Iyer", phone = "98765 43210") {
  const r = await registerPatient(pool(), { full_name: name, phone, gender: "female", age: "34" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.patient;
}

async function bookToday(patientId: string, doctorId = DOCTOR, hour = 11) {
  const slotId = await addSlot(doctorId, istDateString(), hour);
  const appointmentId = newId("APT");
  const dept = (await one<{ department_id: string }>(pool(), `SELECT department_id FROM doctors WHERE doctor_id = $1`, [doctorId]))!;
  await pool().query(
    `INSERT INTO appointments (appointment_id, patient_id, department_id, doctor_id, slot_id, slot_start, slot_end, correlation_id)
     SELECT $1, $2, $3, $4, slot_id, slot_start, slot_end, $6 FROM slots WHERE slot_id = $5`,
    [appointmentId, patientId, dept.department_id, doctorId, slotId, newCorrelationId()],
  );
  await pool().query(`UPDATE slots SET status = 'booked', appointment_id = $1 WHERE slot_id = $2`, [appointmentId, slotId]);
  return appointmentId;
}

beforeEach(async () => {
  await resetData();
});

describe("age", () => {
  it("counts whole years, not rounding up before the birthday", () => {
    expect(ageInYears("1990-06-15", "2026-06-14")).toBe(35);
    expect(ageInYears("1990-06-15", "2026-06-15")).toBe(36);
  });

  it("estimates a birth date that is never in the future", () => {
    expect(estimatedDateOfBirth(0, "2026-03-01") <= "2026-03-01").toBe(true);
    expect(estimatedDateOfBirth(40, "2026-10-10")).toBe("1986-07-01");
  });

  it("shows infants in months and days, and marks estimates", () => {
    expect(formatAge("2026-01-10", false, "2026-04-10")).toBe("3 mo");
    expect(formatAge("2026-04-01", false, "2026-04-06")).toBe("5 d");
    expect(formatAge("1990-07-01", true, "2026-10-10")).toBe("~36 y");
    expect(formatAge(null)).toBe("—");
  });
});

describe("registering patients", () => {
  it("creates a record with a UHID and stores an age as an estimated date of birth", async () => {
    const r = await registerPatient(pool(), { full_name: "Meera Iyer", phone: "98765 43210", gender: "female", age: "34", city: "Pune" });
    expect(r.ok && r.created).toBe(true);
    if (!r.ok) return;
    expect(r.patient.uhid).toMatch(/^UH-\d{6}$/);
    expect(r.patient.phone).toBe("+919876543210");
    expect(r.patient.dob_estimated).toBe(true);
    expect(ageInYears(r.patient.date_of_birth!)).toBeGreaterThanOrEqual(33);
    expect(ageInYears(r.patient.date_of_birth!)).toBeLessThanOrEqual(34);
  });

  it("keeps an exact date of birth as exact", async () => {
    const r = await registerPatient(pool(), { full_name: "Ravi Kumar", phone: "9811122233", gender: "male", date_of_birth: "1985-02-20" });
    expect(r.ok && r.patient.dob_estimated).toBe(false);
    expect(r.ok && r.patient.date_of_birth).toBe("1985-02-20");
  });

  it("gives each patient a different UHID", async () => {
    const a = await patient("Patient A", "9811111111");
    const b = await patient("Patient B", "9822222222");
    expect(a.uhid).not.toBe(b.uhid);
  });

  it("opens the existing patient for a known number and only fills blanks", async () => {
    // As if they had first enquired on WhatsApp: a name and a number, nothing else.
    await pool().query(
      `INSERT INTO patients (patient_id, full_name, phone, source, city) VALUES ('PAT-LEAD', 'Meera I.', '+919876543210', 'instagram', 'Mumbai')`,
    );
    const r = await registerPatient(pool(), {
      full_name: "Meera Iyer",
      phone: "98765 43210",
      gender: "female",
      age: "34",
      city: "Pune",
      allergies: "Penicillin",
    });
    expect(r.ok && r.created).toBe(false);
    if (!r.ok) return;
    expect(r.patient.patient_id).toBe("PAT-LEAD");
    expect(r.patient.full_name).toBe("Meera I."); // never rewritten
    expect(r.patient.city).toBe("Mumbai"); // existing value kept
    expect(r.patient.allergies).toBe("Penicillin"); // blank filled
    expect(r.patient.gender).toBe("female");
    expect(await many(pool(), `SELECT 1 FROM patients`)).toHaveLength(1);
  });

  it("records the consent answer, and leaves it alone when not asked", async () => {
    const yes = await registerPatient(pool(), { full_name: "Asha N", phone: "9833333333", gender: "female", age: "50", whatsapp_consent: "yes" });
    expect(yes.ok && yes.patient.consent_status).toBe("granted");
    const again = await registerPatient(pool(), { full_name: "Asha N", phone: "9833333333", gender: "female", age: "50" });
    expect(again.ok && again.patient.consent_status).toBe("granted");
    const no = await registerPatient(pool(), { full_name: "Asha N", phone: "9833333333", gender: "female", age: "50", whatsapp_consent: "no" });
    expect(no.ok && no.patient.consent_status).toBe("denied");
  });

  it("reports what is wrong, field by field", async () => {
    const r = await registerPatient(pool(), { full_name: "A", phone: "12345", gender: "x" as never });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({ full_name: expect.any(String), gender: expect.any(String) });

    const noAge = await registerPatient(pool(), { full_name: "Valid Name", phone: "9811122233", gender: "male" });
    expect(!noAge.ok && noAge.errors.age).toBeTruthy();
    const badPhone = await registerPatient(pool(), { full_name: "Valid Name", phone: "12345", gender: "male", age: "30" });
    expect(!badPhone.ok && badPhone.errors.phone).toBeTruthy();
    const future = await registerPatient(pool(), {
      full_name: "Valid Name",
      phone: "9811122233",
      gender: "male",
      date_of_birth: addDays(istDateString(), 5),
    });
    expect(!future.ok && future.errors.date_of_birth).toBeTruthy();
  });
});

describe("finding patients", () => {
  beforeEach(async () => {
    await patient("Meera Iyer", "98765 43210");
    await patient("Meera Nair", "98111 22233");
    await patient("Suresh Reddy", "99000 11122");
  });

  it("matches by name fragment, case-insensitively", async () => {
    const r = await searchPatients(pool(), "meera");
    expect(r.map((p) => p.full_name).sort()).toEqual(["Meera Iyer", "Meera Nair"]);
  });

  it("matches by any part of the mobile number", async () => {
    expect((await searchPatients(pool(), "43210")).map((p) => p.full_name)).toEqual(["Meera Iyer"]);
    expect((await searchPatients(pool(), "98111 22233")).map((p) => p.full_name)).toEqual(["Meera Nair"]);
  });

  it("matches by UHID", async () => {
    const [first] = await searchPatients(pool(), "Suresh");
    const r = await searchPatients(pool(), first!.uhid.toLowerCase());
    expect(r).toHaveLength(1);
    expect(r[0]!.full_name).toBe("Suresh Reddy");
  });

  it("treats wildcard characters as plain text", async () => {
    expect(await searchPatients(pool(), "%")).toHaveLength(0);
    expect(await searchPatients(pool(), "_")).toHaveLength(0);
  });

  it("lists recent patients for an empty search", async () => {
    expect((await searchPatients(pool(), "")).length).toBe(3);
  });
});

describe("tokens and the queue", () => {
  it("numbers walk-ins in order of arrival, per doctor", async () => {
    const a = await patient("Patient A", "9811111111");
    const b = await patient("Patient B", "9822222222");
    const c = await patient("Patient C", "9833333333");

    const t1 = await createVisit({ patientId: a.patient_id, doctorId: DOCTOR });
    const t2 = await createVisit({ patientId: b.patient_id, doctorId: DOCTOR });
    const other = await createVisit({ patientId: c.patient_id, doctorId: OTHER_DOCTOR });

    expect([t1.visit.token_number, t2.visit.token_number]).toEqual([1, 2]);
    expect(other.visit.token_number).toBe(1); // a different doctor has their own sequence
  });

  it("never issues the same token twice when many desks act at once", async () => {
    const people = await Promise.all(Array.from({ length: 12 }, (_, i) => patient(`Patient ${i}`, `98100000${String(i).padStart(2, "0")}`)));
    const results = await Promise.all(people.map((p) => createVisit({ patientId: p.patient_id, doctorId: DOCTOR })));
    const tokens = results.map((r) => r.visit.token_number).sort((x, y) => x - y);
    expect(tokens).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("is idempotent for a patient already waiting for that doctor", async () => {
    const p = await patient();
    const first = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    const second = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    expect(second.duplicate).toBe(true);
    expect(second.visit.visit_id).toBe(first.visit.visit_id);
    expect(await many(pool(), `SELECT 1 FROM visits`)).toHaveLength(1);
  });

  it("survives a double click arriving in parallel", async () => {
    const p = await patient();
    const results = await Promise.allSettled([
      createVisit({ patientId: p.patient_id, doctorId: DOCTOR }),
      createVisit({ patientId: p.patient_id, doctorId: DOCTOR }),
    ]);
    // Either both resolve to one visit, or the loser is rejected: never two queue entries.
    expect(await many(pool(), `SELECT 1 FROM visits WHERE status = 'waiting'`)).toHaveLength(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("lets a patient who was removed join again", async () => {
    const p = await patient();
    const first = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    await cancelVisit(first.visit.visit_id, "stepped out");
    const again = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    expect(again.duplicate).toBe(false);
    expect(again.visit.token_number).toBe(2);
  });

  it("rejects an unknown patient or an inactive doctor with a reason", async () => {
    const p = await patient();
    await expect(createVisit({ patientId: "PAT-NOPE", doctorId: DOCTOR })).rejects.toMatchObject({ code: "patient_not_found" });
    await expect(createVisit({ patientId: p.patient_id, doctorId: "DOC-NOPE" })).rejects.toMatchObject({ code: "doctor_not_found" });
    await pool().query(`UPDATE doctors SET active = false WHERE doctor_id = $1`, [DOCTOR]);
    await expect(createVisit({ patientId: p.patient_id, doctorId: DOCTOR })).rejects.toBeInstanceOf(VisitError);
  });

  it("orders the queue: with doctor, urgent, then by token, finished last", async () => {
    const [a, b, c, d] = await Promise.all(
      ["A", "B", "C", "D"].map((n, i) => patient(`Patient ${n}`, `98200000${i}0`.slice(0, 10))),
    );
    const va = await createVisit({ patientId: a!.patient_id, doctorId: DOCTOR });
    const vb = await createVisit({ patientId: b!.patient_id, doctorId: DOCTOR });
    const vc = await createVisit({ patientId: c!.patient_id, doctorId: DOCTOR, priority: "urgent" });
    await createVisit({ patientId: d!.patient_id, doctorId: DOCTOR });
    await startConsultation(va.visit.visit_id);
    await cancelVisit(vb.visit.visit_id, "left");

    const queue = await listQueue(pool());
    expect(queue.map((r) => r.patient_name)).toEqual(["Patient A", "Patient C", "Patient D", "Patient B"]);
    expect(queue[1]!.visit_id).toBe(vc.visit.visit_id);
    expect(queue[1]!.priority).toBe("urgent");
  });

  it("summarises the day", async () => {
    const a = await patient("Patient A", "9811111111");
    const b = await patient("Patient B", "9822222222");
    const va = await createVisit({ patientId: a.patient_id, doctorId: DOCTOR });
    await createVisit({ patientId: b.patient_id, doctorId: DOCTOR });
    await startConsultation(va.visit.visit_id);
    await completeVisit(pool(), va.visit.visit_id);
    expect(await queueSummary(pool())).toMatchObject({ waiting: 1, in_consultation: 0, completed: 1, cancelled: 0 });
  });
});

describe("consultation lifecycle", () => {
  it("calls one patient at a time per doctor", async () => {
    const a = await patient("Patient A", "9811111111");
    const b = await patient("Patient B", "9822222222");
    const va = await createVisit({ patientId: a.patient_id, doctorId: DOCTOR });
    const vb = await createVisit({ patientId: b.patient_id, doctorId: DOCTOR });
    await startConsultation(va.visit.visit_id);
    await expect(startConsultation(vb.visit.visit_id)).rejects.toMatchObject({ code: "doctor_busy" });
    await completeVisit(pool(), va.visit.visit_id);
    await expect(startConsultation(vb.visit.visit_id)).resolves.toMatchObject({ status: "in_consultation" });
  });

  it("treats a repeated start as the same consultation", async () => {
    const p = await patient();
    const v = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    const first = await startConsultation(v.visit.visit_id);
    const second = await startConsultation(v.visit.visit_id);
    expect(second.consult_started_at).toEqual(first.consult_started_at);
  });

  it("will not cancel or re-prioritise someone already with the doctor", async () => {
    const p = await patient();
    const v = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    await startConsultation(v.visit.visit_id);
    await expect(cancelVisit(v.visit.visit_id, "x")).rejects.toMatchObject({ code: "wrong_state" });
    await expect(setVisitPriority(v.visit.visit_id, "urgent")).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("will not complete a visit that never started", async () => {
    const p = await patient();
    const v = await createVisit({ patientId: p.patient_id, doctorId: DOCTOR });
    await expect(completeVisit(pool(), v.visit.visit_id)).rejects.toMatchObject({ code: "wrong_state" });
  });
});

describe("checking in a booked appointment", () => {
  it("takes a token, marks the patient attended and is idempotent", async () => {
    const p = await patient();
    const appointmentId = await bookToday(p.patient_id);

    const first = await checkInAppointment(appointmentId);
    expect(first.visit.source).toBe("appointment");
    expect(first.visit.token_number).toBe(1);

    const appt = await one<{ attendance_status: string }>(pool(), `SELECT attendance_status FROM appointments WHERE appointment_id = $1`, [appointmentId]);
    expect(appt!.attendance_status).toBe("attended");

    const second = await checkInAppointment(appointmentId);
    expect(second.duplicate).toBe(true);
    expect(second.visit.visit_id).toBe(first.visit.visit_id);
    expect(await many(pool(), `SELECT 1 FROM visits`)).toHaveLength(1);
  });

  it("refuses an appointment that is not today", async () => {
    const p = await patient();
    const slotId = await addSlot(DOCTOR, addDays(istDateString(), 3), 10);
    const id = newId("APT");
    await pool().query(
      `INSERT INTO appointments (appointment_id, patient_id, department_id, doctor_id, slot_id, slot_start, slot_end, correlation_id)
       SELECT $1, $2, department_id, doctor_id, slot_id, slot_start, slot_end, $3 FROM slots WHERE slot_id = $4`,
      [id, p.patient_id, newCorrelationId(), slotId],
    );
    await expect(checkInAppointment(id)).rejects.toMatchObject({ code: "appointment_not_today" });
  });

  it("refuses a cancelled appointment", async () => {
    const p = await patient();
    const appointmentId = await bookToday(p.patient_id);
    await pool().query(`UPDATE appointments SET status = 'cancelled' WHERE appointment_id = $1`, [appointmentId]);
    await expect(checkInAppointment(appointmentId)).rejects.toMatchObject({ code: "appointment_not_active" });
  });

  it("lists today's expected patients with their token once they arrive", async () => {
    const p = await patient();
    const appointmentId = await bookToday(p.patient_id);
    expect((await listExpectedToday(pool()))[0]).toMatchObject({ appointment_id: appointmentId, visit_id: null });
    await checkInAppointment(appointmentId);
    expect((await listExpectedToday(pool()))[0]).toMatchObject({ token_number: 1, visit_status: "waiting" });
  });
});
