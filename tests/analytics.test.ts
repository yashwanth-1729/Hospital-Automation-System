import { beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/lib/db";
import { createStaffUser } from "@/server/auth/users";
import { hospitalAnalytics } from "@/server/clinic/analytics";
import { finaliseConsultation, type Actor } from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import { createVisit, startConsultation } from "@/server/clinic/visits";
import { seed } from "../scripts/seed";
import { resetData } from "./helpers";

let doctor: Actor;

async function seen(name: string, phone: string, diagnosis: string, doctorId = "DOC-CAR-1") {
  const r = await registerPatient(pool(), { full_name: name, phone, gender: "male", age: "40" });
  if (!r.ok) throw new Error("register");
  const { visit } = await createVisit({ patientId: r.patient.patient_id, doctorId });
  await startConsultation(visit.visit_id);
  await finaliseConsultation(doctor, visit.visit_id, { chief_complaint: "Review", diagnosis });
}

beforeEach(async () => {
  await resetData();
  await seed(process.env.DATABASE_URL!, { days: 1, quiet: true });
  const u = await createStaffUser(pool(), { email: "rao@h.com", fullName: "Dr Rao", role: "doctor", doctorId: "DOC-CAR-1", password: "correct horse battery" });
  doctor = { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
});

describe("hospital analytics", () => {
  it("is all zeros, with a full run of days, when nothing has happened", async () => {
    const a = await hospitalAnalytics(pool(), 7);
    expect(a.visits.total).toBe(0);
    expect(a.visits_by_day).toHaveLength(7);
    expect(a.visits_by_day.every((d) => d.value === 0)).toBe(true);
    expect(a.wait.average_minutes).toBeNull();
    expect(a.money).toMatchObject({ billed: 0, collected: 0, outstanding: 0 });
  });

  it("counts patients seen and groups diagnoses ignoring case and spacing", async () => {
    await seen("A One", "9810000001", "Viral fever");
    await seen("B Two", "9810000002", "  viral FEVER ");
    await seen("C Three", "9810000003", "Hypertension");
    const a = await hospitalAnalytics(pool(), 7);
    expect(a.visits.completed).toBe(3);
    expect(a.diagnoses[0]).toEqual({ diagnosis: "Viral Fever", n: 2 });
    expect(a.doctors[0]).toMatchObject({ name: "Dr. Ananya Rao", seen: 3 });
    expect(a.visits_by_day.at(-1)!.value).toBe(3);
  });

  it("measures the wait from check-in to being called", async () => {
    await seen("A One", "9810000001", "Fever");
    await pool().query(`UPDATE visits SET checked_in_at = consult_started_at - interval '25 minutes'`);
    const a = await hospitalAnalytics(pool(), 7);
    expect(a.wait.average_minutes).toBe(25);
  });
});
