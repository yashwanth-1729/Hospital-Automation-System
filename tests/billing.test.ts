import { beforeEach, describe, expect, it } from "vitest";
import { many, one, pool } from "@/lib/db";
import { istDateString } from "@/lib/time";
import { createStaffUser } from "@/server/auth/users";
import {
  addLine,
  BillingError,
  createInvoice,
  createInvoiceForVisit,
  daySummary,
  getInvoice,
  issueInvoice,
  listInvoices,
  recordPayment,
  recordRefund,
  removeLine,
  sendInvoiceDueReminder,
  setDiscount,
  unbilledForVisit,
  visitsToBill,
  voidInvoice,
} from "@/server/billing/invoices";
import { finaliseConsultation, type Actor } from "@/server/clinic/consultation";
import { registerPatient } from "@/server/clinic/patients";
import { createVisit, startConsultation } from "@/server/clinic/visits";
import { dispensePrescription, getPrescription } from "@/server/pharmacy/dispense";
import { seed } from "../scripts/seed";
import { q, resetData } from "./helpers";

const PASSWORD = "correct horse battery";
let billing: Actor;
let desk: Actor;
let admin: Actor;
let doctor: Actor;
let pharmacist: Actor;
let seq = 0;

async function staff(email: string, role: "billing" | "receptionist" | "admin" | "doctor" | "pharmacist", doctorId?: string): Promise<Actor> {
  const u = await createStaffUser(pool(), { email, fullName: `Staff ${email}`, role, doctorId, password: PASSWORD });
  return { user_id: u.user_id, role: u.role, doctor_id: u.doctor_id };
}

async function patient() {
  seq += 1;
  const r = await registerPatient(pool(), {
    full_name: `Patient ${seq}`,
    phone: `98100${String(10000 + seq).slice(-5)}`,
    gender: "female",
    age: "35",
    whatsapp_consent: "yes",
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.patient;
}

/** A visit that has been seen and had medicines dispensed, ready to bill. */
async function seenVisit(opts: { dispense?: boolean } = {}) {
  const p = await patient();
  const { visit } = await createVisit({ patientId: p.patient_id, doctorId: "DOC-CAR-1" });
  await startConsultation(visit.visit_id);
  const medicine = "Paracetamol 500 mg";
  await finaliseConsultation(doctor, visit.visit_id, {
    chief_complaint: "Fever",
    diagnosis: "Viral fever",
    items: [{ medicine_name: medicine, dose_units: 1, frequency: "TDS", duration_days: 5, timing: "any" }],
  });
  if (opts.dispense !== false) {
    const rx = await one<{ prescription_id: string }>(pool(), `SELECT prescription_id FROM prescriptions WHERE visit_id = $1`, [visit.visit_id]);
    const detail = await getPrescription(pool(), rx!.prescription_id);
    await dispensePrescription(pharmacist, rx!.prescription_id, [{ itemId: detail!.items[0]!.item_id, quantity: 15 }]);
  }
  return { p, visit };
}

/** An issued invoice for exactly `amount`, built from one manual line. */
async function issued(amount: number) {
  const p = await patient();
  const id = await createInvoice(billing, { patientId: p.patient_id });
  await addLine(billing, id, { description: "Procedure", quantity: 1, unit_price: amount });
  await issueInvoice(billing, id);
  return { id, p };
}

beforeEach(async () => {
  await resetData();
  await seed(process.env.DATABASE_URL!, { days: 1, quiet: true });
  billing = await staff("billing@h.com", "billing");
  desk = await staff("desk@h.com", "receptionist");
  admin = await staff("admin@h.com", "admin");
  doctor = await staff("rao@h.com", "doctor", "DOC-CAR-1");
  pharmacist = await staff("pharm@h.com", "pharmacist");
});

describe("building an invoice from a visit", () => {
  it("brings in the consultation fee and every medicine dispensed", async () => {
    const { visit } = await seenVisit();
    const { invoiceId } = await createInvoiceForVisit(billing, visit.visit_id);
    const inv = await getInvoice(pool(), invoiceId);

    expect(inv!.status).toBe("draft");
    expect(inv!.lines.map((l) => l.kind)).toEqual(["consultation", "pharmacy"]);
    expect(inv!.lines[0]).toMatchObject({ unit_price: 900, quantity: 1, line_total: 900 });
    const med = inv!.lines[1]!;
    expect(med.quantity).toBe(15);
    expect(inv!.subtotal).toBeCloseTo(900 + med.line_total, 2);
    expect(inv!.total).toBeCloseTo(inv!.subtotal, 2);
  });

  it("returns the same draft rather than creating a second", async () => {
    const { visit } = await seenVisit();
    const first = await createInvoiceForVisit(billing, visit.visit_id);
    const second = await createInvoiceForVisit(billing, visit.visit_id);
    expect(second).toEqual({ invoiceId: first.invoiceId, existing: true });
    expect(await many(pool(), `SELECT 1 FROM invoices`)).toHaveLength(1);
  });

  it("never bills the same item twice, even when two people create it at once", async () => {
    const { visit } = await seenVisit();
    await Promise.allSettled([createInvoiceForVisit(billing, visit.visit_id), createInvoiceForVisit(billing, visit.visit_id)]);
    const lines = await many<{ source_ref: string }>(pool(), `SELECT source_ref FROM invoice_lines`);
    expect(new Set(lines.map((l) => l.source_ref)).size).toBe(lines.length);
    expect(lines).toHaveLength(2);
  });

  it("has nothing left to bill once everything is on an issued invoice", async () => {
    const { visit } = await seenVisit();
    const { invoiceId } = await createInvoiceForVisit(billing, visit.visit_id);
    await issueInvoice(billing, invoiceId);
    expect(await unbilledForVisit(pool(), visit.visit_id)).toEqual([]);
    await expect(createInvoiceForVisit(billing, visit.visit_id)).rejects.toMatchObject({ code: "nothing_to_bill" });
  });

  it("lists visits with unbilled charges, and drops them once billed", async () => {
    const { visit } = await seenVisit();
    expect((await visitsToBill(pool())).map((v) => v.visit_id)).toEqual([visit.visit_id]);
    const { invoiceId } = await createInvoiceForVisit(billing, visit.visit_id);
    expect((await visitsToBill(pool()))[0]).toMatchObject({ draft_invoice_id: invoiceId });
    await issueInvoice(billing, invoiceId);
    expect(await visitsToBill(pool())).toEqual([]);
  });

  it("is for billing staff only", async () => {
    const { visit } = await seenVisit();
    await expect(createInvoiceForVisit(desk, visit.visit_id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createInvoiceForVisit(doctor, visit.visit_id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("lines, tax and discounts", () => {
  it("adds and removes manual charges and keeps the total honest", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, id, { description: "ECG", quantity: 1, unit_price: 300 });
    await addLine(billing, id, { description: "Dressing", quantity: 2, unit_price: 150 });
    expect((await getInvoice(pool(), id))!.total).toBe(600);

    const lineId = (await getInvoice(pool(), id))!.lines[0]!.line_id;
    await removeLine(billing, id, lineId);
    expect((await getInvoice(pool(), id))!.total).toBe(300);
  });

  it("rejects a charge with no description, a negative price or zero quantity", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    const r = await addLine(billing, id, { description: "", quantity: 0, unit_price: -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["description", "quantity", "unit_price"]);
  });

  it("adds tax on top of lines that carry a rate", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, id, { description: "Private room, per day", quantity: 2, unit_price: 1000, tax_rate: 12 });
    const inv = await getInvoice(pool(), id);
    expect(inv).toMatchObject({ subtotal: 2000, tax_amount: 240, total: 2240 });
  });

  it("applies a small discount, and tax follows the discounted amount", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, id, { description: "Service", quantity: 1, unit_price: 1000, tax_rate: 18 });
    await setDiscount(billing, id, { mode: "percent", value: 10, reason: "Staff family" });
    expect(await getInvoice(pool(), id)).toMatchObject({ subtotal: 1000, discount_amount: 100, tax_amount: 162, total: 1062 });
  });

  it("needs a reason, and an administrator for a large discount", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, id, { description: "Service", quantity: 1, unit_price: 1000 });

    await expect(setDiscount(billing, id, { mode: "amount", value: 50, reason: "" })).rejects.toMatchObject({ code: "validation" });
    await expect(setDiscount(billing, id, { mode: "percent", value: 25, reason: "Hardship" })).rejects.toMatchObject({ code: "discount_needs_admin" });
    await setDiscount(admin, id, { mode: "percent", value: 25, reason: "Hardship case approved" });
    expect((await getInvoice(pool(), id))!.total).toBe(750);
  });

  it("cannot discount more than the bill", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, id, { description: "Service", quantity: 1, unit_price: 100 });
    await expect(setDiscount(admin, id, { mode: "amount", value: 150, reason: "Too much" })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("issuing", () => {
  it("numbers the invoice, and a draft leaves no gap in the sequence", async () => {
    const p = await patient();
    await createInvoice(billing, { patientId: p.patient_id }); // an abandoned draft
    const a = await issued(100);
    const b = await issued(200);
    const na = (await getInvoice(pool(), a.id))!.invoice_number!;
    const nb = (await getInvoice(pool(), b.id))!.invoice_number!;
    expect(na).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(Number(nb.slice(-6)) - Number(na.slice(-6))).toBe(1);
  });

  it("will not issue an empty invoice", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await expect(issueInvoice(billing, id)).rejects.toMatchObject({ code: "nothing_to_bill" });
  });

  it("freezes the lines once issued", async () => {
    const { id } = await issued(500);
    await expect(addLine(billing, id, { description: "Extra", quantity: 1, unit_price: 10 })).rejects.toMatchObject({ code: "wrong_state" });
    await expect(setDiscount(admin, id, { mode: "amount", value: 10, reason: "late" })).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("treats a fully waived invoice as paid", async () => {
    const p = await patient();
    const id = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, id, { description: "Camp service", quantity: 1, unit_price: 100 });
    await setDiscount(admin, id, { mode: "percent", value: 100, reason: "Free health camp" });
    await issueInvoice(billing, id);
    expect((await getInvoice(pool(), id))!.status).toBe("paid");
  });
});

describe("payments", () => {
  it("moves through partially paid to paid and numbers each receipt", async () => {
    const { id } = await issued(1000);
    const first = await recordPayment(billing, id, { amount: 400, method: "cash" });
    expect(first.balance).toBe(600);
    expect((await getInvoice(pool(), id))!.status).toBe("partially_paid");

    const second = await recordPayment(desk, id, { amount: 600, method: "upi", reference: "UTR12345" });
    expect(second.balance).toBe(0);
    const inv = await getInvoice(pool(), id);
    expect(inv).toMatchObject({ status: "paid", amount_paid: 1000, balance: 0 });
    expect(first.receiptNumber).not.toBe(second.receiptNumber);
    expect(inv!.payments.map((p) => p.method)).toEqual(["cash", "upi"]);
  });

  it("will not take more than is owed", async () => {
    const { id } = await issued(500);
    await expect(recordPayment(billing, id, { amount: 500.01, method: "cash" })).rejects.toMatchObject({ code: "overpayment" });
    await expect(recordPayment(billing, id, { amount: 0, method: "cash" })).rejects.toMatchObject({ code: "validation" });
    await expect(recordPayment(billing, id, { amount: -5, method: "cash" })).rejects.toMatchObject({ code: "validation" });
  });

  it("records one payment when the same form is submitted twice", async () => {
    const { id } = await issued(1000);
    const key = "form-abc-123";
    const a = await recordPayment(billing, id, { amount: 300, method: "cash", idempotencyKey: key });
    const b = await recordPayment(billing, id, { amount: 300, method: "cash", idempotencyKey: key });
    expect(b.duplicate).toBe(true);
    expect(b.paymentId).toBe(a.paymentId);
    expect((await getInvoice(pool(), id))!.amount_paid).toBe(300);
  });

  it("cannot be overpaid by two counters at once", async () => {
    const { id } = await issued(1000);
    const results = await Promise.allSettled([
      recordPayment(billing, id, { amount: 700, method: "cash", idempotencyKey: "k1" }),
      recordPayment(desk, id, { amount: 700, method: "card", idempotencyKey: "k2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as BillingError).code).toBe("overpayment");
    expect((await getInvoice(pool(), id))!.amount_paid).toBe(700);
  });

  it("is refused on a draft, a paid invoice and a void one", async () => {
    const p = await patient();
    const draft = await createInvoice(billing, { patientId: p.patient_id });
    await addLine(billing, draft, { description: "X", quantity: 1, unit_price: 100 });
    await expect(recordPayment(billing, draft, { amount: 50, method: "cash" })).rejects.toMatchObject({ code: "wrong_state" });

    const { id } = await issued(100);
    await recordPayment(billing, id, { amount: 100, method: "cash" });
    await expect(recordPayment(billing, id, { amount: 1, method: "cash" })).rejects.toMatchObject({ code: "wrong_state" });

    const other = await issued(100);
    await voidInvoice(billing, other.id, "Entered in error");
    await expect(recordPayment(billing, other.id, { amount: 10, method: "cash" })).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("is not available to roles that do not handle money", async () => {
    const { id } = await issued(100);
    await expect(recordPayment(doctor, id, { amount: 10, method: "cash" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(recordPayment(pharmacist, id, { amount: 10, method: "cash" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("queues a receipt, and a due-date reminder only while money is owed", async () => {
    const { id } = await issued(1000);
    await recordPayment(billing, id, { amount: 400, method: "cash" });
    expect(await q.jobs("message.send")).toHaveLength(1);
    expect(await q.jobs("billing.invoice_due")).toHaveLength(1);

    await recordPayment(billing, id, { amount: 600, method: "cash" });
    expect(await q.jobs("message.send")).toHaveLength(2);
    expect(await q.jobs("billing.invoice_due")).toHaveLength(1); // not scheduled again
  });
});

describe("refunds and voiding", () => {
  it("returns money and reopens the balance", async () => {
    const { id } = await issued(1000);
    await recordPayment(billing, id, { amount: 1000, method: "cash" });
    await recordRefund(billing, id, { amount: 300, method: "cash", reason: "Medicine returned" });
    expect(await getInvoice(pool(), id)).toMatchObject({ status: "partially_paid", amount_paid: 700, balance: 300 });
    await expect(recordRefund(billing, id, { amount: 800, method: "cash", reason: "Too much" })).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses to void while payments are held, then allows it after a refund", async () => {
    const { id } = await issued(500);
    await recordPayment(billing, id, { amount: 500, method: "cash" });
    await expect(voidInvoice(billing, id, "Wrong patient")).rejects.toMatchObject({ code: "has_payments" });
    await recordRefund(billing, id, { amount: 500, method: "cash", reason: "Wrong patient" });
    await voidInvoice(billing, id, "Wrong patient");
    expect((await getInvoice(pool(), id))!.status).toBe("void");
  });

  it("frees a voided invoice's items so they can be billed again, and cancels its reminder", async () => {
    const { visit } = await seenVisit();
    const { invoiceId } = await createInvoiceForVisit(billing, visit.visit_id);
    await issueInvoice(billing, invoiceId);
    await recordPayment(billing, invoiceId, { amount: 10, method: "cash" }); // schedules a due reminder
    await recordRefund(billing, invoiceId, { amount: 10, method: "cash", reason: "Correction" });
    await voidInvoice(billing, invoiceId, "Wrong doctor fee");

    const due = await q.jobs("billing.invoice_due");
    expect(due[0]!.status).toBe("cancelled");
    expect((await unbilledForVisit(pool(), visit.visit_id)).length).toBe(2);
    const again = await createInvoiceForVisit(billing, visit.visit_id);
    expect(again.existing).toBe(false);
    expect((await getInvoice(pool(), again.invoiceId))!.lines).toHaveLength(2);
  });

  it("requires a reason", async () => {
    const { id } = await issued(100);
    await expect(voidInvoice(billing, id, "")).rejects.toMatchObject({ code: "validation" });
  });
});

describe("the day's figures", () => {
  it("separates collections by method and nets refunds", async () => {
    const a = await issued(1000);
    const b = await issued(500);
    await recordPayment(billing, a.id, { amount: 1000, method: "cash" });
    await recordPayment(billing, b.id, { amount: 200, method: "upi" });
    await recordRefund(billing, a.id, { amount: 100, method: "cash", reason: "Return" });

    const s = await daySummary(pool(), istDateString());
    expect(s).toMatchObject({ collected: 1200, refunded: 100, net: 1100, invoices_issued: 2, billed: 1500, outstanding_count: 2 });
    expect(s.by_method.find((m) => m.method === "cash")!.amount).toBe(900);
    expect(s.by_method.find((m) => m.method === "upi")!.amount).toBe(200);
    expect(s.outstanding_total).toBe(400); // 100 reopened on a, 300 left on b
  });

  it("filters the invoice list", async () => {
    const a = await issued(100);
    await recordPayment(billing, a.id, { amount: 100, method: "cash" });
    await issued(200);
    expect(await listInvoices(pool(), { view: "paid" })).toHaveLength(1);
    expect(await listInvoices(pool(), { view: "unpaid" })).toHaveLength(1);
    expect(await listInvoices(pool(), { view: "all" })).toHaveLength(2);
    expect(await listInvoices(pool(), { view: "all", q: a.p.full_name })).toHaveLength(1);
  });
});

describe("overdue reminder", () => {
  it("is sent while a balance remains, once, and skipped when paid", async () => {
    const { id } = await issued(1000);
    await recordPayment(billing, id, { amount: 400, method: "cash" });
    await sendInvoiceDueReminder(id);
    await sendInvoiceDueReminder(id);
    const msgs = (await q.messages()).filter((m) => m.template_name === "INVOICE_DUE_01");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toContain("₹600.00");

    const paid = await issued(100);
    await recordPayment(billing, paid.id, { amount: 100, method: "cash" });
    await sendInvoiceDueReminder(paid.id);
    expect((await q.messages()).filter((m) => m.template_name === "INVOICE_DUE_01")).toHaveLength(1);
  });
});
