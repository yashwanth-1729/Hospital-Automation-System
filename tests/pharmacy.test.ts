import { beforeEach, describe, expect, it } from "vitest";
import { many, one, pool } from "@/lib/db";
import { addDays, istDateString } from "@/lib/time";
import { createStaffUser } from "@/server/auth/users";
import { finaliseConsultation, getConsultationForVisit, type Actor } from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import { createVisit, startConsultation } from "@/server/clinic/visits";
import {
  closePrescription,
  dispensePrescription,
  getPrescription,
  linkItemToMedicine,
  pharmacyQueue,
} from "@/server/pharmacy/dispense";
import { adjustStock, listBatches, PharmacyError, receiveStock, setReorderLevel, stockOverview } from "@/server/pharmacy/stock";
import { resetData } from "./helpers";

const PASSWORD = "correct horse battery";
let doctor: Actor;
let pharmacist: Actor;
let nurse: Actor;
let counter = 0;

async function staff(email: string, role: "doctor" | "pharmacist" | "nurse", doctorId?: string): Promise<Actor> {
  const u = await createStaffUser(pool(), { email, fullName: `Staff ${email}`, role, doctorId, password: PASSWORD });
  return { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
}

/** A medicine with exact batches, so FEFO and expiry are deterministic. */
async function medicine(name: string, batches: { number: string; days: number; qty: number; price: number }[], reorder = 20) {
  const id = `MED-T-${++counter}`;
  await pool().query(`INSERT INTO medicines (medicine_id, name, generic_name, form, unit, reorder_level) VALUES ($1, $2, $2, 'tablet', 'tablet', $3)`, [
    id,
    name,
    reorder,
  ]);
  for (const b of batches) {
    const batchId = `BAT-${id}-${b.number}`;
    await pool().query(
      `INSERT INTO medicine_batches (batch_id, medicine_id, batch_number, expiry_date, quantity_received, quantity_on_hand, unit_price)
       VALUES ($1, $2, $3, $4::date + $5::int, $6, $6, $7)`,
      [batchId, id, b.number, istDateString(), b.days, b.qty, b.price],
    );
    await pool().query(`INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity) VALUES ($1, $2, 'receipt', $3)`, [id, batchId, b.qty]);
  }
  return id;
}

let phoneSeq = 0;

/** Runs the real consultation flow and returns the issued prescription's id. */
async function prescription(items: { name: string; qty?: number }[], opts: { allergies?: string } = {}) {
  const r = await registerPatient(pool(), {
    full_name: `Patient ${++phoneSeq}`,
    phone: `98000${String(10000 + phoneSeq).slice(-5)}`,
    gender: "male",
    age: "40",
    allergies: opts.allergies,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const { visit } = await createVisit({ patientId: r.patient.patient_id, doctorId: "DOC-CAR-1" });
  await startConsultation(visit.visit_id);
  const res = await finaliseConsultation(doctor, visit.visit_id, {
    chief_complaint: "Test",
    diagnosis: "Test",
    items: items.map((i) => ({
      medicine_name: i.name,
      dose_units: 1,
      frequency: "OD",
      duration_days: i.qty ?? 10,
      timing: "any",
    })),
  });
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  const c = await getConsultationForVisit(pool(), visit.visit_id);
  const rx = await one<{ prescription_id: string }>(pool(), `SELECT prescription_id FROM prescriptions WHERE consultation_id = $1`, [c!.consultation_id]);
  return rx!.prescription_id;
}

const onHand = async (medicineId: string) =>
  (await one<{ n: number }>(pool(), `SELECT COALESCE(sum(quantity_on_hand), 0)::int AS n FROM medicine_batches WHERE medicine_id = $1`, [medicineId]))!.n;

/** Every batch's cached on-hand must equal the sum of its ledger entries. */
async function ledgerBalances() {
  const rows = await many<{ batch_id: string; on_hand: number; ledger: number }>(
    pool(),
    `SELECT b.batch_id, b.quantity_on_hand AS on_hand, COALESCE(sum(s.quantity), 0)::int AS ledger
       FROM medicine_batches b LEFT JOIN stock_movements s ON s.batch_id = b.batch_id
      GROUP BY b.batch_id`,
  );
  return rows.filter((r) => r.on_hand !== r.ledger);
}

beforeEach(async () => {
  await resetData();
  doctor = await staff("rao@h.com", "doctor", "DOC-CAR-1");
  pharmacist = await staff("pharm@h.com", "pharmacist");
  nurse = await staff("nurse@h.com", "nurse");
});

describe("stock levels", () => {
  it("separates what can be dispensed from what has expired", async () => {
    const id = await medicine("Test Tablet", [
      { number: "OLD", days: -10, qty: 40, price: 2 },
      { number: "SOON", days: 30, qty: 25, price: 2 },
      { number: "LONG", days: 400, qty: 100, price: 2 },
    ]);
    const row = (await stockOverview(pool())).find((r) => r.medicine_id === id)!;
    expect(row).toMatchObject({ available: 125, expired: 40, expiring_soon: 25, status: "ok" });
  });

  it("flags low and out-of-stock against the reorder level", async () => {
    const low = await medicine("Low Tablet", [{ number: "A", days: 200, qty: 15, price: 1 }], 20);
    const out = await medicine("Out Tablet", [{ number: "A", days: -1, qty: 50, price: 1 }], 20);
    const rows = await stockOverview(pool());
    expect(rows.find((r) => r.medicine_id === low)!.status).toBe("low");
    expect(rows.find((r) => r.medicine_id === out)!.status).toBe("out"); // only expired units: nothing dispensable
  });
});

describe("receiving stock", () => {
  it("creates a batch and writes the ledger entry", async () => {
    const id = await medicine("Receive Tablet", []);
    const r = await receiveStock(pharmacist, {
      medicine_id: id,
      batch_number: "L2601",
      expiry_date: addDays(istDateString(), 365),
      quantity: 200,
      unit_cost: 1.5,
      unit_price: 2.5,
      supplier: "Acme Pharma",
    });
    expect(r.ok).toBe(true);
    expect(await onHand(id)).toBe(200);
    expect(await ledgerBalances()).toEqual([]);
  });

  it("adds a repeat delivery of the same batch to it", async () => {
    const id = await medicine("Receive Tablet", []);
    const base = { medicine_id: id, batch_number: "L2601", expiry_date: addDays(istDateString(), 365), unit_price: 2 };
    await receiveStock(pharmacist, { ...base, quantity: 100 });
    const again = await receiveStock(pharmacist, { ...base, quantity: 50 });
    expect(again.ok && again.toppedUp).toBe(true);
    expect(await onHand(id)).toBe(150);
    expect(await listBatches(pool(), id)).toHaveLength(1);
    expect(await ledgerBalances()).toEqual([]);
  });

  it("will not mix expiry dates under one batch number", async () => {
    const id = await medicine("Receive Tablet", []);
    await receiveStock(pharmacist, { medicine_id: id, batch_number: "L1", expiry_date: addDays(istDateString(), 100), quantity: 10, unit_price: 1 });
    const r = await receiveStock(pharmacist, { medicine_id: id, batch_number: "L1", expiry_date: addDays(istDateString(), 200), quantity: 10, unit_price: 1 });
    expect(!r.ok && r.errors.batch_number).toBeTruthy();
    expect(await onHand(id)).toBe(10);
  });

  it("refuses an expired batch, a zero quantity and a missing price", async () => {
    const id = await medicine("Receive Tablet", []);
    const r = await receiveStock(pharmacist, { medicine_id: id, batch_number: "X", expiry_date: addDays(istDateString(), -1), quantity: 0, unit_price: "" as never });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(expect.arrayContaining(["expiry_date", "quantity", "unit_price"]));
  });

  it("is for the pharmacy only", async () => {
    const id = await medicine("Receive Tablet", []);
    await expect(
      receiveStock(doctor, { medicine_id: id, batch_number: "X", expiry_date: addDays(istDateString(), 100), quantity: 5, unit_price: 1 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(setReorderLevel(nurse, id, 5)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("adjusting stock", () => {
  it("writes off units with a reason, never below zero", async () => {
    const id = await medicine("Adjust Tablet", [{ number: "A", days: 100, qty: 30, price: 1 }]);
    const batch = (await listBatches(pool(), id))[0]!;
    await adjustStock(pharmacist, { batchId: batch.batch_id, delta: -12, reason: "Damaged in storage" });
    expect(await onHand(id)).toBe(18);
    await expect(adjustStock(pharmacist, { batchId: batch.batch_id, delta: -19, reason: "Too many" })).rejects.toMatchObject({ code: "insufficient_stock" });
    await expect(adjustStock(pharmacist, { batchId: batch.batch_id, delta: -1, reason: "" })).rejects.toMatchObject({ code: "validation" });
    expect(await ledgerBalances()).toEqual([]);
  });
});

describe("dispensing", () => {
  it("lists issued prescriptions in the pharmacy queue", async () => {
    await medicine("Queue Tablet", [{ number: "A", days: 100, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Queue Tablet" }]);
    const queue = await pharmacyQueue(pool());
    expect(queue.map((q) => q.prescription_id)).toEqual([rx]);
    expect(queue[0]).toMatchObject({ items: 1, outstanding: 1, status: "issued" });
  });

  it("uses the batch that expires first and prices each unit at the batch it came from", async () => {
    const id = await medicine("Fefo Tablet", [
      { number: "LATE", days: 300, qty: 100, price: 5 },
      { number: "EARLY", days: 40, qty: 6, price: 3 },
    ]);
    const rx = await prescription([{ name: "Fefo Tablet", qty: 10 }]);
    const p = await getPrescription(pool(), rx);
    const r = await dispensePrescription(pharmacist, rx, [{ itemId: p!.items[0]!.item_id, quantity: 10 }]);

    // 6 from the early batch at 3.00 and 4 from the later at 5.00.
    expect(r.total).toBe(6 * 3 + 4 * 5);
    expect(r.prescriptionStatus).toBe("dispensed");
    const batches = await listBatches(pool(), id);
    expect(batches.find((b) => b.batch_number === "EARLY")!.quantity_on_hand).toBe(0);
    expect(batches.find((b) => b.batch_number === "LATE")!.quantity_on_hand).toBe(96);
    expect(await ledgerBalances()).toEqual([]);
  });

  it("never takes from an expired batch", async () => {
    const id = await medicine("Expiry Tablet", [
      { number: "DEAD", days: -5, qty: 100, price: 1 },
      { number: "LIVE", days: 90, qty: 4, price: 1 },
    ]);
    const rx = await prescription([{ name: "Expiry Tablet", qty: 10 }]);
    const p = await getPrescription(pool(), rx);
    expect(p!.items[0]!.available).toBe(4);
    await expect(dispensePrescription(pharmacist, rx, [{ itemId: p!.items[0]!.item_id, quantity: 10 }])).rejects.toMatchObject({
      code: "insufficient_stock",
    });
    expect((await listBatches(pool(), id)).find((b) => b.batch_number === "DEAD")!.quantity_on_hand).toBe(100);
  });

  it("supports part-dispensing, then the rest later", async () => {
    const id = await medicine("Partial Tablet", [{ number: "A", days: 200, qty: 100, price: 2 }]);
    const rx = await prescription([{ name: "Partial Tablet", qty: 10 }]);
    const itemId = (await getPrescription(pool(), rx))!.items[0]!.item_id;

    const first = await dispensePrescription(pharmacist, rx, [{ itemId, quantity: 4 }]);
    expect(first.prescriptionStatus).toBe("partially_dispensed");
    expect((await pharmacyQueue(pool()))[0]).toMatchObject({ prescription_id: rx, outstanding: 1, status: "partially_dispensed" });

    const second = await dispensePrescription(pharmacist, rx, [{ itemId, quantity: 6 }]);
    expect(second.prescriptionStatus).toBe("dispensed");
    expect(await pharmacyQueue(pool())).toHaveLength(0);
    expect(await onHand(id)).toBe(90);
    expect((await getPrescription(pool(), rx))!.dispensations).toHaveLength(2);
  });

  it("will not hand over more than was prescribed", async () => {
    await medicine("Over Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Over Tablet", qty: 5 }]);
    const itemId = (await getPrescription(pool(), rx))!.items[0]!.item_id;
    await expect(dispensePrescription(pharmacist, rx, [{ itemId, quantity: 6 }])).rejects.toMatchObject({ code: "over_dispense" });
  });

  it("changes nothing when any line cannot be filled", async () => {
    const plenty = await medicine("Plenty Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const scarce = await medicine("Scarce Tablet", [{ number: "A", days: 200, qty: 2, price: 1 }]);
    const rx = await prescription([{ name: "Plenty Tablet", qty: 5 }, { name: "Scarce Tablet", qty: 5 }]);
    const items = (await getPrescription(pool(), rx))!.items;

    await expect(
      dispensePrescription(pharmacist, rx, items.map((i) => ({ itemId: i.item_id, quantity: 5 }))),
    ).rejects.toMatchObject({ code: "insufficient_stock" });

    expect(await onHand(plenty)).toBe(100); // the fillable line was not taken either
    expect(await onHand(scarce)).toBe(2);
    expect(await many(pool(), `SELECT 1 FROM dispensations`)).toHaveLength(0);
    expect((await getPrescription(pool(), rx))!.status).toBe("issued");
  });

  it("gives the last units to one counter when two dispense at once", async () => {
    const id = await medicine("Race Tablet", [{ number: "A", days: 200, qty: 10, price: 1 }]);
    const a = await prescription([{ name: "Race Tablet", qty: 8 }]);
    const b = await prescription([{ name: "Race Tablet", qty: 8 }]);
    const itemA = (await getPrescription(pool(), a))!.items[0]!.item_id;
    const itemB = (await getPrescription(pool(), b))!.items[0]!.item_id;

    const results = await Promise.allSettled([
      dispensePrescription(pharmacist, a, [{ itemId: itemA, quantity: 8 }]),
      dispensePrescription(pharmacist, b, [{ itemId: itemB, quantity: 8 }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as PharmacyError).code).toBe("insufficient_stock");
    expect(await onHand(id)).toBe(2);
    expect(await ledgerBalances()).toEqual([]);
  });

  it("handles the same prescription submitted twice at once", async () => {
    const id = await medicine("Twice Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Twice Tablet", qty: 5 }]);
    const itemId = (await getPrescription(pool(), rx))!.items[0]!.item_id;
    const results = await Promise.allSettled([
      dispensePrescription(pharmacist, rx, [{ itemId, quantity: 5 }]),
      dispensePrescription(pharmacist, rx, [{ itemId, quantity: 5 }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await onHand(id)).toBe(95);
  });

  it("is for the pharmacy, and only for open prescriptions", async () => {
    await medicine("Gate Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Gate Tablet", qty: 5 }]);
    const itemId = (await getPrescription(pool(), rx))!.items[0]!.item_id;
    await expect(dispensePrescription(nurse, rx, [{ itemId, quantity: 5 }])).rejects.toMatchObject({ code: "forbidden" });
    await expect(dispensePrescription(doctor, rx, [{ itemId, quantity: 5 }])).rejects.toMatchObject({ code: "forbidden" });
    await dispensePrescription(pharmacist, rx, [{ itemId, quantity: 5 }]);
    await expect(dispensePrescription(pharmacist, rx, [{ itemId, quantity: 1 }])).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("needs a quantity", async () => {
    await medicine("Zero Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Zero Tablet" }]);
    const itemId = (await getPrescription(pool(), rx))!.items[0]!.item_id;
    await expect(dispensePrescription(pharmacist, rx, [{ itemId, quantity: 0 }])).rejects.toMatchObject({ code: "nothing_to_dispense" });
  });
});

describe("medicines the formulary did not know", () => {
  it("must be matched to a product before dispensing", async () => {
    const real = await medicine("Matched Tablet", [{ number: "A", days: 200, qty: 100, price: 4 }]);
    const rx = await prescription([{ name: "Brand-X tablet" }]);
    const p = await getPrescription(pool(), rx);
    expect(p!.items[0]!.medicine_id).toBeNull();

    await expect(dispensePrescription(pharmacist, rx, [{ itemId: p!.items[0]!.item_id, quantity: 1 }])).rejects.toMatchObject({ code: "not_linked" });

    await linkItemToMedicine(pharmacist, p!.items[0]!.item_id, real);
    const r = await dispensePrescription(pharmacist, rx, [{ itemId: p!.items[0]!.item_id, quantity: 10 }]);
    expect(r.total).toBe(40);
  });
});

describe("closing a prescription", () => {
  it("removes it from the queue and keeps the reason", async () => {
    await medicine("Close Tablet", [{ number: "A", days: 200, qty: 3, price: 1 }]);
    const rx = await prescription([{ name: "Close Tablet", qty: 10 }]);
    const itemId = (await getPrescription(pool(), rx))!.items[0]!.item_id;
    await dispensePrescription(pharmacist, rx, [{ itemId, quantity: 3 }]);

    await closePrescription(pharmacist, rx, "Out of stock; patient will buy the rest outside");
    const p = await getPrescription(pool(), rx);
    expect(p).toMatchObject({ status: "dispensed", pharmacy_note: expect.stringMatching(/out of stock/i) });
    expect(await pharmacyQueue(pool())).toHaveLength(0);
  });

  it("cancels a prescription that was never filled", async () => {
    await medicine("Never Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Never Tablet" }]);
    await closePrescription(pharmacist, rx, "Patient declined");
    expect((await getPrescription(pool(), rx))!.status).toBe("cancelled");
  });

  it("requires a reason", async () => {
    await medicine("Reason Tablet", [{ number: "A", days: 200, qty: 100, price: 1 }]);
    const rx = await prescription([{ name: "Reason Tablet" }]);
    await expect(closePrescription(pharmacist, rx, " ")).rejects.toMatchObject({ code: "validation" });
  });
});
