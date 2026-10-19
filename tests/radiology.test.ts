import { beforeEach, describe, expect, it } from "vitest";
import { many, pool } from "@/lib/db";
import { can } from "@/lib/rbac";
import { askAssistant, buildHospitalContext } from "@/server/ai/assistant";
import { createStaffUser } from "@/server/auth/users";
import type { Actor } from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import { createVisit, startConsultation } from "@/server/clinic/visits";
import { orderStudy, startStudy, submitReport, worklist, ImagingError } from "@/server/radiology/imaging";
import { seed } from "../scripts/seed";
import { resetData } from "./helpers";

const PASSWORD = "correct horse battery";
let doctor: Actor;
let otherDoctor: Actor;
let radiologist: Actor;
let nurse: Actor;

async function staff(email: string, role: "doctor" | "nurse" | "radiology", doctorId?: string): Promise<Actor> {
  const u = await createStaffUser(pool(), { email, fullName: `Staff ${email}`, role, doctorId, password: PASSWORD });
  return { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
}

async function visit() {
  const r = await registerPatient(pool(), { full_name: "Meera Iyer", phone: "98765 43210", gender: "female", age: "34", whatsapp_consent: "yes" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const { visit } = await createVisit({ patientId: r.patient.patient_id, doctorId: "DOC-CAR-1" });
  await startConsultation(visit.visit_id);
  return visit;
}

beforeEach(async () => {
  await resetData();
  await seed(process.env.DATABASE_URL!, { days: 1, quiet: true });
  doctor = await staff("rao@h.com", "doctor", "DOC-CAR-1");
  otherDoctor = await staff("menon@h.com", "doctor", "DOC-CAR-2");
  radiologist = await staff("rad@h.com", "radiology");
  nurse = await staff("nurse@h.com", "nurse");
});

describe("radiology permissions", () => {
  it("radiology reports but does not order; only admin uses the assistant", () => {
    expect(can("radiology", "imaging.report")).toBe(true);
    expect(can("radiology", "imaging.order")).toBe(false);
    expect(can("radiology", "assistant.use")).toBe(false);
    expect(can("admin", "assistant.use")).toBe(true);
    for (const r of ["receptionist", "doctor", "nurse", "pharmacist", "billing"] as const) expect(can(r, "assistant.use")).toBe(false);
  });
});

describe("imaging flow", () => {
  it("doctor orders, radiology starts and reports, doctor sees the result", async () => {
    const v = await visit();
    const { orderId } = await orderStudy(doctor, { visitId: v.visit_id, study: "Chest X-ray", indication: "Cough" });
    expect((await worklist(pool())).open.map((o) => o.order_id)).toContain(orderId);
    await startStudy(radiologist, orderId);
    await submitReport(radiologist, orderId, { findings: "Lungs clear", impression: "Normal chest" });
    const [row] = await many<{ status: string; impression: string }>(pool(), `SELECT status, impression FROM imaging_orders WHERE order_id = $1`, [orderId]);
    expect(row).toMatchObject({ status: "reported", impression: "Normal chest" });
  });

  it("refuses a second report, an empty impression, and the wrong people", async () => {
    const v = await visit();
    const { orderId } = await orderStudy(doctor, { visitId: v.visit_id, study: "Chest X-ray" });
    await expect(submitReport(radiologist, orderId, { impression: " " })).rejects.toBeInstanceOf(ImagingError);
    await expect(submitReport(nurse, orderId, { impression: "Normal" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(orderStudy(otherDoctor, { visitId: v.visit_id, study: "CT brain" })).rejects.toMatchObject({ code: "not_your_patient" });
    await expect(orderStudy(radiologist, { visitId: v.visit_id, study: "CT brain" })).rejects.toMatchObject({ code: "forbidden" });
    await submitReport(radiologist, orderId, { impression: "Normal" });
    await expect(submitReport(radiologist, orderId, { impression: "Changed" })).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("puts urgent studies first", async () => {
    const v = await visit();
    await orderStudy(doctor, { visitId: v.visit_id, study: "Ultrasound abdomen" });
    const urgent = await orderStudy(doctor, { visitId: v.visit_id, study: "CT brain", priority: "urgent" });
    expect((await worklist(pool())).open[0]!.order_id).toBe(urgent.orderId);
  });
});

describe("admin assistant", () => {
  it("never puts phone numbers or emails in what it sends to the AI", async () => {
    await visit();
    const ctx = await buildHospitalContext(pool());
    expect(ctx).not.toMatch(/98765/);
    expect(ctx).not.toMatch(/@/);
    expect(ctx).not.toMatch(/Meera Iyer/);
  });

  it("asks the model with the data and returns its answer; says so when no key", async () => {
    let body: { messages: { content: string }[] } | undefined;
    const fake = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "3 patients." } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await askAssistant(pool(), "How many patients?", [], fake, { AI_PROVIDER: "openai_compatible", AI_API_KEY: "test-key" });
    expect(r).toEqual({ answer: "3 patients.", ai: true });
    expect(body!.messages[0]!.content).toContain("DATA:");
    expect((await askAssistant(pool(), "Hi", [], fake)).ai).toBe(false);
  });
});
