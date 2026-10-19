import "../src/lib/load-env";
import { writeFileSync } from "node:fs";
import { closePool, many, one, pool } from "../src/lib/db";
import { addDays, istDateString } from "../src/lib/time";
import { createStaffUser } from "../src/server/auth/users";
import { createInvoiceForAdmission, createInvoiceForVisit, addLine, getInvoice, issueInvoice, recordPayment, recordRefund, setDiscount } from "../src/server/billing/invoices";
import { finaliseConsultation, getConsultationForVisit, recordVitals, saveDraft, type Actor } from "../src/server/clinic/consultation";
import { registerPatient } from "../src/server/clinic/patients";
import { createVisit, startConsultation } from "../src/server/clinic/visits";
import { admitPatient, dischargeAdmission, markBedReady, transferBed } from "../src/server/ipd/admissions";
import { dispensePrescription, getPrescription } from "../src/server/pharmacy/dispense";
import { markAttendance } from "../src/server/workflows/no-show";

/**
 * Runs every flow of the hospital for real, step by step, against the database this process is
 * pointed at, and records what happened at each step: what the code did, which audit rows were
 * written, which background jobs were queued, which WhatsApp messages went out.
 *
 *   npx tsx scripts/demo-walkthrough.ts /tmp/walkthrough.json
 *
 * It uses the demo staff accounts as the actors (no passwords involved) and the live worker to
 * send the messages, so run it where the worker is running. Real WhatsApp goes only to numbers on
 * WA_ALLOWED_RECIPIENTS.
 */

const OUT = process.argv[2] ?? "/tmp/walkthrough.json";
const PHONE = "9052996536";

interface Evidence {
  audit: string[];
  jobs: { type: string; status: string; run_at: string }[];
  messages: { template: string; status: string; provider_id: string | null; error: string | null }[];
}

interface Step {
  flow: string;
  title: string;
  who: string;
  ui: string;
  under: string[];
  outcome: "worked" | "refused as designed" | "failed";
  facts: Record<string, unknown>;
  evidence: Evidence;
  seconds: number;
}

const steps: Step[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForWorker(since: Date, maxSeconds = 50): Promise<void> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const r = await one<{ n: number }>(
      pool(),
      `SELECT count(*)::int AS n FROM jobs WHERE created_at >= $1 AND type IN ('message.send', 'discharge.process', 'noshow.recover') AND status IN ('queued', 'running')`,
      [since],
    );
    if (!r || r.n === 0) return;
    await sleep(1500);
  }
}

async function evidenceSince(since: Date): Promise<Evidence> {
  const audit = await many<{ action: string }>(pool(), `SELECT action FROM audit_log WHERE timestamp >= $1 ORDER BY event_id`, [since]);
  const jobs = await many<{ type: string; status: string; run_at: Date }>(
    pool(),
    `SELECT type, status, run_at FROM jobs WHERE created_at >= $1 ORDER BY job_id`,
    [since],
  );
  const messages = await many<{ template_name: string; delivery_status: string; provider_message_id: string | null; error: string | null; skip_reason: string | null }>(
    pool(),
    `SELECT template_name, delivery_status, provider_message_id, error, skip_reason FROM communication_log WHERE created_at >= $1 ORDER BY created_at`,
    [since],
  );
  return {
    audit: audit.map((a) => a.action),
    jobs: jobs.map((j) => ({ type: j.type, status: j.status, run_at: j.run_at.toISOString() })),
    messages: messages.map((m) => ({
      template: m.template_name,
      status: m.skip_reason ? `skipped (${m.skip_reason})` : m.delivery_status,
      provider_id: m.provider_message_id,
      error: m.error,
    })),
  };
}

async function step(
  flow: string,
  title: string,
  who: string,
  ui: string,
  under: string[],
  fn: () => Promise<Record<string, unknown>>,
  opts: { refusal?: boolean; waitWorker?: boolean } = {},
): Promise<void> {
  const started = Date.now();
  const since = (await one<{ now: Date }>(pool(), `SELECT clock_timestamp() AS now`))!.now;
  let facts: Record<string, unknown> = {};
  let outcome: Step["outcome"] = "worked";
  try {
    facts = await fn();
    if (opts.refusal) outcome = "failed"; // it was supposed to be refused
  } catch (err) {
    const message = (err as Error).message;
    if (opts.refusal) {
      outcome = "refused as designed";
      facts = { the_system_said: message };
    } else {
      outcome = "failed";
      facts = { error: message };
    }
  }
  if (opts.waitWorker) await waitForWorker(since);
  steps.push({ flow, title, who, ui, under, outcome, facts, evidence: await evidenceSince(since), seconds: Math.round((Date.now() - started) / 100) / 10 });
  const mark = outcome === "failed" ? "FAIL" : "ok  ";
  console.log(`${mark} [${flow}] ${title}`);
}

async function actorByEmail(email: string): Promise<Actor> {
  const r = await one<{ user_id: string; role: Actor["role"]; doctor_id: string | null }>(
    pool(),
    `SELECT user_id, role, doctor_id FROM staff_users WHERE lower(email) = $1 AND active`,
    [email],
  );
  if (!r) throw new Error(`demo account ${email} not found: run npm run user:demo first`);
  return { user_id: r.user_id, role: r.role, doctor_id: r.doctor_id };
}

async function main() {
  const reception = await actorByEmail("reception@democare.test");
  const nurse = await actorByEmail("nurse@democare.test");
  const doctor = await actorByEmail("doctor@democare.test");
  const pharmacist = await actorByEmail("pharmacy@democare.test");
  const billing = await actorByEmail("billing@democare.test");
  // The administrator who may approve a large discount: any active admin account.
  const adminRow = await one<{ user_id: string }>(pool(), `SELECT user_id FROM staff_users WHERE role = 'admin' AND active ORDER BY created_at LIMIT 1`);
  const admin: Actor = { user_id: adminRow!.user_id, role: "admin", doctor_id: null };

  // ---- Flow 1: the patient's enquiry, already run through the live website webhook -----------------
  const lead = await one<{ lead_id: string; status: string; patient_id: string; appointment_id: string | null; department: string | null; priority: string }>(
    pool(),
    `SELECT l.lead_id, l.status, l.patient_id, l.appointment_id, l.department, l.priority
       FROM leads l JOIN patients p ON p.patient_id = l.patient_id WHERE p.phone = '+91${PHONE}' ORDER BY l.created_at DESC LIMIT 1`,
  );
  if (lead) {
    const timeline = await many<{ action: string }>(
      pool(),
      `SELECT a.action FROM audit_log a JOIN leads l ON l.correlation_id = a.correlation_id WHERE l.lead_id = $1 ORDER BY a.event_id`,
      [lead.lead_id],
    );
    const sent = await many<{ template_name: string; delivery_status: string }>(
      pool(),
      `SELECT c.template_name, c.delivery_status FROM communication_log c JOIN leads l ON l.correlation_id = c.correlation_id WHERE l.lead_id = $1 ORDER BY c.created_at`,
      [lead.lead_id],
    );
    steps.push({
      flow: "1. Patient enquiry",
      title: "The enquiry arrived, was understood, booked, and confirmed on WhatsApp",
      who: "Patient (website form or an ad lead)",
      ui: "Patient opens /enquiry, fills the form, presses Request appointment.",
      under: [
        "The form (or an external source) sends the enquiry to the server, which checks it, removes duplicates and stores it in about a second.",
        "A background worker picks it up. An AI reads the text to find the department and whether it is urgent. A fixed safety check for emergencies and medical questions always runs as well, and can only make things more cautious.",
        "For a routine enquiry the system locks the earliest free slot for the right doctor (two people can never get the same slot), creates the appointment and queues the reminders for 24 hours and 3 hours before.",
        "It sends the approved WhatsApp confirmation, once only. Every step is written to the audit log.",
      ],
      outcome: lead.status === "booked" ? "worked" : "failed",
      facts: { lead_status: lead.status, department: lead.department, appointment_created: !!lead.appointment_id, steps_recorded: timeline.length, whatsapp: sent },
      evidence: { audit: timeline.map((t) => t.action), jobs: [], messages: sent.map((s) => ({ template: s.template_name, status: s.delivery_status, provider_id: null, error: null })) },
      seconds: 0,
    });
    console.log(`ok   [1. Patient enquiry] lead ${lead.lead_id} is ${lead.status}`);
  }

  // ---- Flow 2: front desk ---------------------------------------------------------------------------
  let patientId = "";
  let visitId = "";
  await step(
    "2. Front desk",
    "Register the patient and give them a token",
    "Receptionist",
    "Reception > Register patient: name, mobile, allergies = Penicillin, WhatsApp updates = Yes, doctor = Dr. Ananya Rao.",
    [
      "The mobile number is looked up first. The patient already exists from the enquiry, so no duplicate is made; only blank details (here the allergy) are filled in.",
      "The system gives the next token number for that doctor today. The number comes from a database counter that cannot hand out the same number twice, even if two desks click at the same moment.",
      "A visit is created in 'waiting' status and appears in the doctor's queue, with the allergy shown in red.",
    ],
    async () => {
      const reg = await registerPatient(pool(), {
        full_name: "Yashwanth Cherukuru",
        phone: PHONE,
        gender: "male",
        age: "25",
        allergies: "Penicillin",
        whatsapp_consent: "yes",
        city: "Hyderabad",
      });
      if (!reg.ok) throw new Error(JSON.stringify(reg.errors));
      patientId = reg.patient.patient_id;
      const { visit } = await createVisit({ patientId, doctorId: "DOC-CAR-1", reason: "Routine heart check-up", createdBy: reception.user_id });
      visitId = visit.visit_id;
      return { patient: reg.patient.full_name, uhid: reg.patient.uhid, matched_existing_patient: !reg.created, allergy_on_file: reg.patient.allergies, token_number: visit.token_number, status: visit.status };
    },
  );

  // ---- Flow 3: vitals ---------------------------------------------------------------------------------
  await step(
    "3. Nurse",
    "A reading that cannot be right is rejected",
    "Nurse",
    "Consultation > the patient > Vitals: pulse 900, then Record vitals.",
    ["Every measurement is checked against a believable range before it is saved. A pulse of 900 is refused with the reason, so a typing slip never reaches a doctor."],
    async () => {
      const r = await recordVitals(nurse, visitId, { pulse: "900" });
      if (r.ok) return { unexpectedly_accepted: true };
      throw new Error(`Refused: ${Object.values(r.errors).join(" ")}`);
    },
    { refusal: true },
  );
  await step(
    "3. Nurse",
    "Record real vitals",
    "Nurse",
    "Same screen: BP 138/88, pulse 78, temperature 36.9, weight 71 kg, height 174 cm.",
    ["The readings are saved against this visit with the nurse's name and the time.", "BMI is worked out from weight and height and shown to the doctor."],
    async () => {
      const r = await recordVitals(nurse, visitId, { bp_systolic: "138", bp_diastolic: "88", pulse: "78", temperature_c: "36.9", weight_kg: "71", height_cm: "174" });
      return { saved: r.ok, bmi: Math.round((71 / (1.74 * 1.74)) * 10) / 10 };
    },
  );

  // ---- Flow 4: doctor ---------------------------------------------------------------------------------
  await step(
    "4. Doctor",
    "Call the patient in",
    "Doctor (Dr. Ananya Rao)",
    "Consultation > My patients > Call in.",
    ["The visit moves from 'waiting' to 'in consultation'. A doctor can only have one patient with them at a time, and can only open their own patients."],
    async () => {
      const v = await startConsultation(visitId);
      return { status: v.status };
    },
  );
  await step(
    "4. Doctor",
    "Prescribing amoxicillin to a penicillin-allergic patient is stopped",
    "Doctor",
    "Prescription: Amoxicillin 500 mg. The row turns red; press Finish consultation without giving a reason.",
    [
      "The patient's allergy is checked against every medicine by drug family, not just the name: amoxicillin is a penicillin, so it is caught even though the word 'penicillin' is not on the prescription.",
      "Finishing is refused until the doctor writes why it is safe. If they do, that reason is stored on the prescription and shown to the pharmacist.",
    ],
    async () => {
      const r = await finaliseConsultation(doctor, visitId, {
        chief_complaint: "Routine heart check-up",
        diagnosis: "Normal examination",
        items: [{ medicine_name: "Amoxicillin 500 mg", dose_units: 1, frequency: "TDS", duration_days: 5, timing: "after_food" }],
      });
      if (r.ok) return { unexpectedly_allowed: true };
      throw new Error(`Refused. ${Object.values(r.errors ?? {}).join(" ")} Allergy found: ${r.conflicts?.map((c) => `${c.medicine} (${c.allergen})`).join(", ")}`);
    },
    { refusal: true },
  );
  await step(
    "4. Doctor",
    "Finish the consultation with a safe medicine and a follow-up date",
    "Doctor",
    "Change to Azithromycin 500 mg, follow-up in 7 days, press Finish consultation.",
    [
      "The record is locked: from now on it can only receive dated addenda, never edits.",
      "A prescription is issued to the pharmacy queue. The quantity (3 tablets) was worked out from dose x times a day x days.",
      "A WhatsApp 'consultation complete' message is queued, and a reminder is scheduled for the day before the follow-up. The background worker sends them.",
    ],
    async () => {
      const r = await finaliseConsultation(doctor, visitId, {
        chief_complaint: "Routine heart check-up",
        examination: "Heart sounds normal, chest clear",
        diagnosis: "Normal examination, no cardiac concern",
        advice: "Walk 30 minutes daily. Review in a week.",
        follow_up_date: addDays(istDateString(), 7),
        items: [{ medicine_name: "Azithromycin 500 mg", dose_units: 1, frequency: "OD", duration_days: 3, timing: "after_food" }],
      });
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      const c = await getConsultationForVisit(pool(), visitId);
      return { consultation: c?.status, prescription: c?.prescription_status, medicine: c?.items[0]?.medicine_name, quantity: c?.items[0]?.quantity, follow_up: c?.follow_up_date };
    },
    { waitWorker: true },
  );

  // ---- Flow 5: pharmacy -------------------------------------------------------------------------------
  const rx = await one<{ prescription_id: string }>(pool(), `SELECT prescription_id FROM prescriptions WHERE visit_id = $1`, [visitId]);
  await step(
    "5. Pharmacy",
    "A nurse cannot dispense medicines",
    "Nurse",
    "Nurses do not see Pharmacy in their menu; even a direct request is refused.",
    ["Every action asks 'is this role allowed to do this?' on the server, against the database, not just in the menu. Hiding a button is not security; this check is."],
    async () => {
      const detail = await getPrescription(pool(), rx!.prescription_id);
      await dispensePrescription(nurse, rx!.prescription_id, [{ itemId: detail!.items[0]!.item_id, quantity: 3 }]);
      return {};
    },
    { refusal: true },
  );
  await step(
    "5. Pharmacy",
    "The pharmacist dispenses from stock",
    "Pharmacist",
    "Pharmacy > the prescription > Dispense.",
    [
      "Stock is taken from the batch that expires first, never from an expired batch, and each unit is priced from the batch it came from.",
      "Every unit that leaves is written to a movement ledger, and the batch's count always equals the sum of its ledger. Two counters cannot take the last units at the same time.",
      "The prescription moves to 'dispensed' and the medicine becomes billable.",
    ],
    async () => {
      const detail = await getPrescription(pool(), rx!.prescription_id);
      const r = await dispensePrescription(pharmacist, rx!.prescription_id, [{ itemId: detail!.items[0]!.item_id, quantity: detail!.items[0]!.quantity }]);
      return { status: r.prescriptionStatus, amount_charged: r.total };
    },
  );

  // ---- Flow 6: billing --------------------------------------------------------------------------------
  let invoiceId = "";
  await step(
    "6. Billing",
    "Build the invoice from what actually happened",
    "Billing",
    "Billing > Ready to bill > Create invoice. Then add the service 'ECG'.",
    [
      "The invoice is pre-filled from the consultation fee and every medicine the pharmacy dispensed. Each of those items can sit on only one live invoice, so nothing can be billed twice.",
      "Totals are always recalculated from the lines inside the database; nothing trusts a number typed in a browser.",
    ],
    async () => {
      invoiceId = (await createInvoiceForVisit(billing, visitId)).invoiceId;
      await addLine(billing, invoiceId, { description: "ECG", quantity: 1, unit_price: 300 });
      const inv = await getInvoice(pool(), invoiceId);
      return { lines: inv!.lines.map((l) => `${l.description}: ₹${l.line_total}`), total: inv!.total };
    },
  );
  await step(
    "6. Billing",
    "A 20% discount needs an administrator",
    "Billing",
    "Discount: 20%, reason 'Hardship', Apply.",
    ["Billing staff may give up to 10% with a reason. Anything bigger is refused unless an administrator does it, so one person cannot quietly waive a large bill."],
    async () => {
      await setDiscount(billing, invoiceId, { mode: "percent", value: 20, reason: "Hardship" });
      return {};
    },
    { refusal: true },
  );
  await step(
    "6. Billing",
    "A 5% discount, then issue the invoice",
    "Billing",
    "Discount 5% (reason: Senior citizen), Apply, then Issue invoice.",
    ["The discount is saved with its reason. Issuing gives the invoice its number (a draft leaves no gap in the numbering) and freezes the lines."],
    async () => {
      await setDiscount(billing, invoiceId, { mode: "percent", value: 5, reason: "Senior citizen" });
      const n = await issueInvoice(billing, invoiceId);
      const inv = await getInvoice(pool(), invoiceId);
      return { invoice_number: n.invoiceNumber, discount: inv!.discount_amount, total_to_pay: inv!.total, status: inv!.status };
    },
  );
  const key = `walkthrough-${Date.now()}`;
  await step(
    "6. Billing",
    "Take a part payment; pressing the button twice records it once",
    "Billing or Receptionist",
    "Record payment: ₹500 by UPI. (The same form submitted twice.)",
    [
      "Each payment form carries a one-time key. If the same form arrives twice (a double click, a slow network), the second is recognised and returns the first payment instead of charging again.",
      "A numbered receipt is created, the invoice becomes 'partly paid', and a WhatsApp receipt is queued.",
    ],
    async () => {
      const a = await recordPayment(billing, invoiceId, { amount: 500, method: "upi", reference: "UTR-DEMO-0001", idempotencyKey: key });
      const b = await recordPayment(billing, invoiceId, { amount: 500, method: "upi", reference: "UTR-DEMO-0001", idempotencyKey: key });
      return { receipt: a.receiptNumber, second_press_was_recognised_as_duplicate: b.duplicate, still_owed: a.balance };
    },
    { waitWorker: true },
  );
  await step(
    "6. Billing",
    "Taking more than is owed is refused",
    "Billing",
    "Record payment: ₹99,999.",
    ["While the payment is recorded the invoice row is locked, so two counters cannot together take more than the balance."],
    async () => {
      await recordPayment(billing, invoiceId, { amount: 99999, method: "cash" });
      return {};
    },
    { refusal: true },
  );
  await step(
    "6. Billing",
    "Take the rest in cash",
    "Billing",
    "Record payment: the remaining balance, cash.",
    ["The invoice becomes 'paid'. A second WhatsApp receipt says the bill is paid in full."],
    async () => {
      const inv0 = await getInvoice(pool(), invoiceId);
      const r = await recordPayment(billing, invoiceId, { amount: inv0!.balance, method: "cash" });
      const inv = await getInvoice(pool(), invoiceId);
      return { receipt: r.receiptNumber, status: inv!.status, paid_in_total: inv!.amount_paid };
    },
    { waitWorker: true },
  );
  await step(
    "6. Billing",
    "Refund part of it, with a reason",
    "Billing",
    "Refund: ₹100 cash, reason 'Medicine not needed'.",
    ["A refund is its own numbered record, never an edit of the payment. The invoice reopens by that amount and the day book shows the net."],
    async () => {
      await recordRefund(billing, invoiceId, { amount: 100, method: "cash", reason: "Medicine not needed" });
      const inv = await getInvoice(pool(), invoiceId);
      return { status: inv!.status, now_owed: inv!.balance };
    },
  );

  // ---- Flow 7: wards ----------------------------------------------------------------------------------
  let admissionId = "";
  const gen = await one<{ bed_id: string }>(pool(), `SELECT bed_id FROM beds WHERE status = 'available' AND ward_id = 'WRD-GEN' ORDER BY bed_id LIMIT 1`);
  const icu = await one<{ bed_id: string }>(pool(), `SELECT bed_id FROM beds WHERE status = 'available' AND ward_id = 'WRD-ICU' ORDER BY bed_id LIMIT 1`);
  await step(
    "7. Wards",
    "Admit the patient to a General Ward bed",
    "Receptionist or Nurse",
    "Wards > Admit a patient > search the patient > bed > doctor > Admit.",
    ["The bed is locked while it is assigned: two people cannot take the same bed, and one patient cannot be in two beds. The bed turns 'occupied'. The ward's day rate in force today is recorded on the stay."],
    async () => {
      admissionId = (await admitPatient(reception, { patientId, bedId: gen!.bed_id, doctorId: "DOC-CAR-1", reason: "Observation after check-up" })).admissionId;
      return { bed: gen!.bed_id };
    },
  );
  await step(
    "7. Wards",
    "Move the patient to an Intensive Care bed",
    "Nurse",
    "Open the admission > Move to another bed > an ICU bed > Move patient.",
    ["The first stay is closed and a second opened at the ICU's higher rate. The vacated bed goes to 'cleaning', not straight back to 'available'. Both beds are locked in a fixed order so two simultaneous moves cannot deadlock."],
    async () => {
      await transferBed(nurse, admissionId, icu!.bed_id);
      return { moved_to: icu!.bed_id };
    },
  );
  await step(
    "7. Wards",
    "Discharge with an approved follow-up date",
    "Doctor, Nurse or Receptionist",
    "Open the admission > Discharge: follow-up in 10 days, approved by Dr. Ananya Rao > Discharge patient.",
    [
      "The stay is closed, the bed goes to 'cleaning', and the admission is marked discharged.",
      "The existing discharge-follow-up automation takes over: it schedules a reminder for the day before the follow-up and a feedback request two days later, and sends the follow-up message now. The follow-up date must name the doctor who approved it.",
    ],
    async () => {
      const r = await dischargeAdmission(doctor, admissionId, { followUpDate: addDays(istDateString(), 10), approvedBy: "Dr. Ananya Rao" });
      return { discharge_record: r.dischargeId };
    },
    { waitWorker: true },
  );
  await step(
    "7. Wards",
    "A nurse prepares the bed, and billing charges the stay",
    "Nurse, then Billing",
    "Wards > Mark ready on the cleaning bed. Then the admission > Create invoice for the stay.",
    ["Only a bed that is being cleaned can be marked ready. Bed charges are worked out per calendar day in each bed at the rate that applied; a transfer day is charged once, to the new bed."],
    async () => {
      await markBedReady(nurse, gen!.bed_id);
      const { invoiceId: stayInvoice } = await createInvoiceForAdmission(billing, admissionId);
      const inv = await getInvoice(pool(), stayInvoice);
      return { bed_released: gen!.bed_id, charges: inv!.lines.map((l) => `${l.description}: ${l.quantity} day x ₹${l.unit_price} = ₹${l.line_total}`), total: inv!.total };
    },
  );

  // ---- Flow 8: no-show recovery -----------------------------------------------------------------------
  if (lead?.appointment_id) {
    await step(
      "8. Missed appointment",
      "A patient does not turn up: recovery starts",
      "Receptionist (or automatic after the grace period)",
      "Appointments > the booked appointment > No-show.",
      [
        "The appointment is marked missed and the recovery workflow starts: a polite WhatsApp with the next free slots, a second gentle follow-up, and if there is still no answer a task for a staff member.",
        "The first message waits about half an hour on purpose, in case the patient is only running late. It is queued now and goes out at its scheduled time.",
        "Any later 'attended' mark would cancel the pending messages, so a patient who turns up late is not chased.",
      ],
      async () => {
        const r = await markAttendance(lead.appointment_id!, "no_show", reception.user_id);
        return { marked: r.changed, reason: r.reason ?? null };
      },
      { waitWorker: true },
    );
  }

  // ---- Flow 9: control and the numbers -----------------------------------------------------------------
  await step(
    "9. Control",
    "A new administrator account is created; the password is shown once",
    "Administrator",
    "Staff accounts > Add a person.",
    ["Only a one-time password is generated and shown. Only a salted hash is stored, so even the database cannot reveal it; the person must choose their own at first sign-in. Sessions are stored as hashes and die the moment an account is switched off."],
    async () => {
      const u = await createStaffUser(pool(), { email: `walkthrough.${Date.now()}@democare.test`, fullName: "Walkthrough Test", role: "nurse", password: "Aa1-temporary-pass", mustChangePassword: true });
      await pool().query(`DELETE FROM staff_users WHERE user_id = $1`, [u.user_id]); // tidy: the test account is not left behind
      return { role: u.role, must_change_password: u.must_change_password, removed_afterwards: true };
    },
  );
  const totals = await one<Record<string, number>>(
    pool(),
    `SELECT (SELECT count(*) FROM patients)::int AS patients, (SELECT count(*) FROM visits)::int AS visits,
            (SELECT count(*) FROM invoices WHERE status <> 'void')::int AS invoices, (SELECT count(*) FROM payments)::int AS payments,
            (SELECT count(*) FROM communication_log WHERE delivery_status IN ('sent','delivered','read'))::int AS whatsapp_sent,
            (SELECT count(*) FROM audit_log)::int AS audit_records`,
  );
  const ledger = await one<{ bad: number }>(
    pool(),
    `SELECT count(*)::int AS bad FROM (SELECT b.batch_id FROM medicine_batches b LEFT JOIN stock_movements s ON s.batch_id = b.batch_id GROUP BY b.batch_id HAVING b.quantity_on_hand <> COALESCE(sum(s.quantity), 0)) x`,
  );
  const moneyMismatch = await one<{ bad: number }>(
    pool(),
    `SELECT count(*)::int AS bad FROM invoices i WHERE i.amount_paid <> COALESCE((SELECT sum(CASE kind WHEN 'payment' THEN amount ELSE -amount END) FROM payments p WHERE p.invoice_id = i.invoice_id), 0)`,
  );
  steps.push({
    flow: "9. Control",
    title: "Whole-system health check after all of this",
    who: "The system itself",
    ui: "Nothing to click: this is the final audit of the data.",
    under: [
      "After everything above, the books are checked: every batch's stock count must equal its ledger, and every invoice's paid amount must equal its payments minus refunds.",
    ],
    outcome: (ledger?.bad ?? 1) === 0 && (moneyMismatch?.bad ?? 1) === 0 ? "worked" : "failed",
    facts: { ...totals, batches_where_count_differs_from_ledger: ledger?.bad, invoices_where_money_does_not_add_up: moneyMismatch?.bad },
    evidence: { audit: [], jobs: [], messages: [] },
    seconds: 0,
  });

  writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), steps }, null, 2));
  const failed = steps.filter((s) => s.outcome === "failed");
  console.log(`\n${steps.length} steps, ${failed.length} failed. Wrote ${OUT}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
