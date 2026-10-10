import { beforeEach, describe, expect, it } from "vitest";
import { stayDays } from "@/lib/bed-days";
import { many, one, pool } from "@/lib/db";
import { createStaffUser } from "@/server/auth/users";
import { createInvoiceForAdmission, getInvoice, issueInvoice, unbilledForAdmission } from "@/server/billing/invoices";
import type { Actor } from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import {
  addWard,
  admitPatient,
  availableBeds,
  bedBoard,
  dischargeAdmission,
  getAdmission,
  IpdError,
  markBedReady,
  occupancy,
  setBedMaintenance,
  staysFor,
  transferBed,
} from "@/server/ipd/admissions";
import { seed } from "../scripts/seed";
import { q, resetData } from "./helpers";

const PASSWORD = "correct horse battery";
let nurse: Actor;
let admin: Actor;
let doctor: Actor;
let billing: Actor;
let pharmacist: Actor;
let seq = 0;

async function staff(email: string, role: "nurse" | "admin" | "doctor" | "billing" | "pharmacist", doctorId?: string): Promise<Actor> {
  const u = await createStaffUser(pool(), { email, fullName: `Staff ${email}`, role, doctorId, password: PASSWORD });
  return { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
}

async function patient() {
  seq += 1;
  const r = await registerPatient(pool(), {
    full_name: `Inpatient ${seq}`,
    phone: `97000${String(10000 + seq).slice(-5)}`,
    gender: "male",
    age: "55",
    whatsapp_consent: "yes",
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.patient;
}

const GEN_1 = "BED-G01";
const GEN_2 = "BED-G02";
const ICU_1 = "BED-I01";

async function admit(bedId = GEN_1) {
  const p = await patient();
  const { admissionId } = await admitPatient(nurse, { patientId: p.patient_id, bedId, doctorId: "DOC-CAR-1", reason: "Chest pain, observation" });
  return { p, admissionId };
}

const bedStatus = async (bedId: string) => (await one<{ status: string }>(pool(), `SELECT status FROM beds WHERE bed_id = $1`, [bedId]))!.status;

/** Pushes an admission's start back in time so multi-day stays can be tested. */
async function backdate(admissionId: string, days: number) {
  await pool().query(`UPDATE bed_stays SET started_at = started_at - make_interval(days => $2) WHERE admission_id = $1`, [admissionId, days]);
  await pool().query(`UPDATE admissions SET admitted_at = admitted_at - make_interval(days => $2) WHERE admission_id = $1`, [admissionId, days]);
}

beforeEach(async () => {
  await resetData();
  await seed(process.env.DATABASE_URL!, { days: 1, quiet: true });
  nurse = await staff("nurse@h.com", "nurse");
  admin = await staff("admin@h.com", "admin");
  doctor = await staff("rao@h.com", "doctor", "DOC-CAR-1");
  billing = await staff("billing@h.com", "billing");
  pharmacist = await staff("pharm@h.com", "pharmacist");
});

describe("chargeable days", () => {
  const at = (iso: string) => new Date(iso);

  it("charges one day for a same-day admission and discharge", () => {
    expect(stayDays({ startedAt: at("2026-10-10T04:00:00Z"), endedAt: at("2026-10-10T10:00:00Z"), endedReason: "discharge" })).toBe(1);
  });

  it("counts each calendar day the patient was in", () => {
    expect(stayDays({ startedAt: at("2026-10-10T04:00:00Z"), endedAt: at("2026-10-13T04:00:00Z"), endedReason: "discharge" })).toBe(4);
  });

  it("charges a transfer day to the new bed only", () => {
    // Bed A: 10th to 12th, moved on the 12th. Bed B: from the 12th.
    expect(stayDays({ startedAt: at("2026-10-10T04:00:00Z"), endedAt: at("2026-10-12T06:00:00Z"), endedReason: "transfer" })).toBe(2);
    expect(stayDays({ startedAt: at("2026-10-12T06:00:00Z"), endedAt: at("2026-10-13T04:00:00Z"), endedReason: "discharge" })).toBe(2);
  });

  it("charges nothing for a bed held and left on the same day", () => {
    expect(stayDays({ startedAt: at("2026-10-10T04:00:00Z"), endedAt: at("2026-10-10T09:00:00Z"), endedReason: "transfer" })).toBe(0);
  });

  it("counts days in India, not UTC", () => {
    // 20:00 UTC on the 10th is 01:30 IST on the 11th.
    expect(stayDays({ startedAt: at("2026-10-10T20:00:00Z"), endedAt: at("2026-10-11T04:00:00Z"), endedReason: "discharge" })).toBe(1);
    expect(stayDays({ startedAt: at("2026-10-10T17:00:00Z"), endedAt: at("2026-10-11T04:00:00Z"), endedReason: "discharge" })).toBe(2);
  });
});

describe("admitting", () => {
  it("occupies the bed and opens a stay at the ward's rate", async () => {
    const { admissionId } = await admit(GEN_1);
    expect(await bedStatus(GEN_1)).toBe("occupied");
    const stays = await staysFor(pool(), admissionId);
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ ended_at: null, daily_rate: 800, ward_name: "General Ward" });
  });

  it("puts the patient on the board and takes the bed off the available list", async () => {
    const { p } = await admit(GEN_1);
    const board = await bedBoard(pool());
    const bed = board.flatMap((w) => w.beds).find((b) => b.bed_id === GEN_1)!;
    expect(bed).toMatchObject({ status: "occupied", patient_name: p.full_name });
    expect((await availableBeds(pool())).some((b) => b.bed_id === GEN_1)).toBe(false);
  });

  it("will not use an occupied bed, or admit someone twice", async () => {
    const { p } = await admit(GEN_1);
    const other = await patient();
    await expect(admitPatient(nurse, { patientId: other.patient_id, bedId: GEN_1, doctorId: "DOC-CAR-1" })).rejects.toMatchObject({ code: "bed_unavailable" });
    await expect(admitPatient(nurse, { patientId: p.patient_id, bedId: GEN_2, doctorId: "DOC-CAR-1" })).rejects.toMatchObject({ code: "already_admitted" });
  });

  it("gives a single bed to one of two simultaneous admissions", async () => {
    const [a, b] = [await patient(), await patient()];
    const results = await Promise.allSettled([
      admitPatient(nurse, { patientId: a.patient_id, bedId: GEN_1, doctorId: "DOC-CAR-1" }),
      admitPatient(nurse, { patientId: b.patient_id, bedId: GEN_1, doctorId: "DOC-CAR-1" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await many(pool(), `SELECT 1 FROM bed_stays WHERE bed_id = $1 AND ended_at IS NULL`, [GEN_1])).toHaveLength(1);
  });

  it("refuses a bed under maintenance and an unknown doctor or patient", async () => {
    await setBedMaintenance(nurse, GEN_2, true);
    const p = await patient();
    await expect(admitPatient(nurse, { patientId: p.patient_id, bedId: GEN_2, doctorId: "DOC-CAR-1" })).rejects.toMatchObject({ code: "bed_unavailable" });
    await expect(admitPatient(nurse, { patientId: p.patient_id, bedId: GEN_1, doctorId: "DOC-NOPE" })).rejects.toMatchObject({ code: "not_found" });
    await expect(admitPatient(nurse, { patientId: "PAT-NOPE", bedId: GEN_1, doctorId: "DOC-CAR-1" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("is for ward and front-desk staff, not the pharmacy", async () => {
    const p = await patient();
    await expect(admitPatient(pharmacist, { patientId: p.patient_id, bedId: GEN_1, doctorId: "DOC-CAR-1" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("moving a patient", () => {
  it("frees the old bed for cleaning and keeps both stays", async () => {
    const { admissionId } = await admit(GEN_1);
    await transferBed(nurse, admissionId, ICU_1);
    expect(await bedStatus(GEN_1)).toBe("cleaning");
    expect(await bedStatus(ICU_1)).toBe("occupied");
    const stays = await staysFor(pool(), admissionId);
    expect(stays.map((s) => [s.bed_label, s.ended_reason])).toEqual([["G-01", "transfer"], ["I-01", null]]);
    expect(stays[1]!.daily_rate).toBe(7500);
  });

  it("will not move into an occupied bed or the one they are in", async () => {
    const a = await admit(GEN_1);
    await admit(GEN_2);
    await expect(transferBed(nurse, a.admissionId, GEN_2)).rejects.toMatchObject({ code: "bed_unavailable" });
    await expect(transferBed(nurse, a.admissionId, GEN_1)).rejects.toMatchObject({ code: "same_bed" });
  });

  it("lets only one of two patients move into the same free bed", async () => {
    const a = await admit(GEN_1);
    const b = await admit(GEN_2);
    const results = await Promise.allSettled([transferBed(nurse, a.admissionId, ICU_1), transferBed(nurse, b.admissionId, ICU_1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await many(pool(), `SELECT 1 FROM bed_stays WHERE bed_id = $1 AND ended_at IS NULL`, [ICU_1])).toHaveLength(1);
  });
});

describe("discharging", () => {
  it("frees the bed for cleaning and hands over to the follow-up workflow", async () => {
    const { admissionId, p } = await admit(GEN_1);
    const r = await dischargeAdmission(doctor, admissionId, { followUpDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), approvedBy: "Dr. Ananya Rao" });
    expect(r.dischargeId).toBeTruthy();

    expect(await bedStatus(GEN_1)).toBe("cleaning");
    const adm = await getAdmission(pool(), admissionId);
    expect(adm).toMatchObject({ status: "discharged", discharge_id: r.dischargeId });

    const d = await one<{ patient_id: string; encounter_id: string; approved_by: string }>(
      pool(),
      `SELECT patient_id, encounter_id, approved_by FROM discharges WHERE discharge_id = $1`,
      [r.dischargeId],
    );
    expect(d).toMatchObject({ patient_id: p.patient_id, encounter_id: admissionId, approved_by: "Dr. Ananya Rao" });
    expect(await q.jobs("discharge.process")).toHaveLength(1);
  });

  it("needs a named approver for a follow-up date, and not a past date", async () => {
    const { admissionId } = await admit(GEN_1);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await expect(dischargeAdmission(doctor, admissionId, { followUpDate: future })).rejects.toMatchObject({ code: "validation" });
    await expect(dischargeAdmission(doctor, admissionId, { followUpDate: "2020-01-01", approvedBy: "Dr X" })).rejects.toMatchObject({ code: "validation" });
    expect((await getAdmission(pool(), admissionId))!.status).toBe("admitted"); // nothing changed
  });

  it("can discharge without a follow-up date", async () => {
    const { admissionId } = await admit(GEN_1);
    await expect(dischargeAdmission(nurse, admissionId)).resolves.toMatchObject({ dischargeId: expect.any(String) });
  });

  it("cannot be done twice, and lets the patient be admitted again after", async () => {
    const { admissionId, p } = await admit(GEN_1);
    await dischargeAdmission(nurse, admissionId);
    await expect(dischargeAdmission(nurse, admissionId)).rejects.toMatchObject({ code: "wrong_state" });
    await markBedReady(nurse, GEN_1);
    await expect(admitPatient(nurse, { patientId: p.patient_id, bedId: GEN_1, doctorId: "DOC-CAR-1" })).resolves.toBeTruthy();
  });

  it("is not available to billing or pharmacy staff", async () => {
    const { admissionId } = await admit(GEN_1);
    await expect(dischargeAdmission(billing, admissionId)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("bed housekeeping", () => {
  it("turns a cleaned bed back to available, and only a cleaning bed", async () => {
    const { admissionId } = await admit(GEN_1);
    await expect(markBedReady(nurse, GEN_1)).rejects.toBeInstanceOf(IpdError); // occupied
    await dischargeAdmission(nurse, admissionId);
    await markBedReady(nurse, GEN_1);
    expect(await bedStatus(GEN_1)).toBe("available");
  });

  it("takes an empty bed out of service and back", async () => {
    await setBedMaintenance(nurse, GEN_2, true);
    expect(await bedStatus(GEN_2)).toBe("maintenance");
    await setBedMaintenance(nurse, GEN_2, false);
    expect(await bedStatus(GEN_2)).toBe("available");
    const { admissionId } = await admit(GEN_1);
    await expect(setBedMaintenance(nurse, GEN_1, true)).rejects.toMatchObject({ code: "wrong_state" });
    void admissionId;
  });

  it("is for nurses and administrators", async () => {
    await expect(markBedReady(doctor, GEN_1)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reports occupancy by ward", async () => {
    await admit(GEN_1);
    await admit(GEN_2);
    const g = (await occupancy(pool())).find((w) => w.ward_id === "WRD-GEN")!;
    expect(g).toMatchObject({ total: 12, occupied: 2, available: 10 });
  });
});

describe("administration", () => {
  it("lets an administrator add a ward with its beds", async () => {
    const { wardId } = await addWard(admin, { name: "Paediatric Ward", kind: "general", dailyRate: 1200, beds: 4 });
    const beds = await many<{ label: string }>(pool(), `SELECT label FROM beds WHERE ward_id = $1 ORDER BY label`, [wardId]);
    expect(beds.map((b) => b.label)).toEqual(["PA-01", "PA-02", "PA-03", "PA-04"]);
    await expect(addWard(admin, { name: "paediatric ward", kind: "general", dailyRate: 1, beds: 1 })).rejects.toMatchObject({ code: "validation" });
    await expect(addWard(nurse, { name: "Another", kind: "general", dailyRate: 1, beds: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("billing a stay", () => {
  it("cannot be billed until the patient has been discharged", async () => {
    const { admissionId } = await admit(GEN_1);
    expect(await unbilledForAdmission(pool(), admissionId)).toEqual([]);
    await expect(createInvoiceForAdmission(billing, admissionId)).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("charges each day in each bed at the rate in force", async () => {
    const { admissionId } = await admit(GEN_1);
    await backdate(admissionId, 3); // admitted three days ago
    await transferBed(nurse, admissionId, ICU_1); // moved to ICU today
    await dischargeAdmission(nurse, admissionId); // and discharged today

    const { invoiceId } = await createInvoiceForAdmission(billing, admissionId);
    const inv = await getInvoice(pool(), invoiceId);
    const lines = inv!.lines;
    expect(lines).toHaveLength(2);
    // General: the three days before the transfer day. ICU: today, once.
    expect(lines[0]).toMatchObject({ kind: "bed", quantity: 3, unit_price: 800, line_total: 2400 });
    expect(lines[1]).toMatchObject({ kind: "bed", quantity: 1, unit_price: 7500, line_total: 7500 });
    expect(inv!.total).toBe(9900);
  });

  it("is not billed twice once issued", async () => {
    const { admissionId } = await admit(GEN_1);
    await dischargeAdmission(nurse, admissionId);
    const { invoiceId } = await createInvoiceForAdmission(billing, admissionId);
    await issueInvoice(billing, invoiceId);
    await expect(createInvoiceForAdmission(billing, admissionId)).rejects.toMatchObject({ code: "nothing_to_bill" });
  });
});
