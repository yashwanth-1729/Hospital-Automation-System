import { z } from "zod";
import { audit } from "@/lib/audit";
import { many, one, pool, tx, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { newCorrelationId, newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { METHODS, METHOD_LABEL, type PaymentMethod } from "@/lib/payment-methods";
import { can } from "@/lib/rbac";
import { addDays, istAt, istDateString } from "@/lib/time";
import type { Actor } from "@/server/clinic/consultation";
import { sendTemplateMessage } from "@/server/messaging/send";
import { JOB } from "@/server/workflows/job-types";

export type BillingErrorCode =
  | "forbidden"
  | "not_found"
  | "wrong_state"
  | "nothing_to_bill"
  | "validation"
  | "overpayment"
  | "discount_needs_admin"
  | "has_payments";

export class BillingError extends Error {
  constructor(
    public readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Discounts above this share of the subtotal need an administrator. */
export const DISCOUNT_LIMIT_PERCENT = 10;
export const DEFAULT_DUE_DAYS = 7;

export { METHODS, METHOD_LABEL, type PaymentMethod };

function need(actor: Actor, capability: Parameters<typeof can>[1], message: string): void {
  if (!can(actor.role, capability)) throw new BillingError("forbidden", message);
}

export type InvoiceStatus = "draft" | "issued" | "partially_paid" | "paid" | "void";

export interface InvoiceLine {
  line_id: string;
  position: number;
  kind: "consultation" | "pharmacy" | "service" | "bed" | "other";
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  line_total: number;
}

export interface PaymentRow {
  payment_id: string;
  kind: "payment" | "refund";
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  reason: string | null;
  receipt_number: string | null;
  received_at: Date;
  received_by_name: string;
}

export interface Invoice {
  invoice_id: string;
  invoice_number: string | null;
  status: InvoiceStatus;
  patient_id: string;
  patient_name: string;
  uhid: string;
  phone: string;
  visit_id: string | null;
  subtotal: number;
  discount_amount: number;
  discount_reason: string | null;
  tax_amount: number;
  total: number;
  amount_paid: number;
  balance: number;
  due_date: string | null;
  notes: string | null;
  issued_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  correlation_id: string;
  lines: InvoiceLine[];
  payments: PaymentRow[];
}

const HEAD = `
  i.invoice_id, i.invoice_number, i.status, i.patient_id, p.full_name AS patient_name, p.uhid, p.phone, i.visit_id,
  i.subtotal::float AS subtotal, i.discount_amount::float AS discount_amount, i.discount_reason,
  i.tax_amount::float AS tax_amount, i.total::float AS total, i.amount_paid::float AS amount_paid,
  (i.total - i.amount_paid)::float AS balance, i.due_date, i.notes, i.issued_at, i.voided_at, i.void_reason,
  i.created_at, i.correlation_id`;

export async function getInvoice(db: Db, invoiceId: string): Promise<Invoice | null> {
  const head = await one<Omit<Invoice, "lines" | "payments">>(
    db,
    `SELECT ${HEAD} FROM invoices i JOIN patients p ON p.patient_id = i.patient_id WHERE i.invoice_id = $1`,
    [invoiceId],
  );
  if (!head) return null;
  const [lines, payments] = await Promise.all([
    many<InvoiceLine>(
      db,
      `SELECT line_id, position, kind, description, quantity::float AS quantity, unit_price::float AS unit_price,
              tax_rate::float AS tax_rate, line_total::float AS line_total
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY position`,
      [invoiceId],
    ),
    many<PaymentRow>(
      db,
      `SELECT pay.payment_id, pay.kind, pay.amount::float AS amount, pay.method, pay.reference, pay.reason, pay.receipt_number,
              pay.received_at, u.full_name AS received_by_name
         FROM payments pay JOIN staff_users u ON u.user_id = pay.received_by
        WHERE pay.invoice_id = $1 ORDER BY pay.received_at, pay.payment_id`,
      [invoiceId],
    ),
  ]);
  return { ...head, lines, payments };
}

/** Totals are always recomputed in the database from the lines, never trusted from a caller. */
async function recalc(c: Db, invoiceId: string): Promise<void> {
  await c.query(
    `WITH s AS (
       SELECT COALESCE(sum(line_total), 0) AS sub, COALESCE(sum(round(line_total * tax_rate / 100, 2)), 0) AS tax
         FROM invoice_lines WHERE invoice_id = $1
     ), d AS (
       SELECT s.sub, s.tax, LEAST(i.discount_amount, s.sub) AS disc
         FROM s, invoices i WHERE i.invoice_id = $1
     ), t AS (
       SELECT d.sub, d.disc,
              CASE WHEN d.sub = 0 THEN 0 ELSE round(d.tax * (1 - d.disc / d.sub), 2) END AS tax
         FROM d
     )
     UPDATE invoices i
        SET subtotal = t.sub, discount_amount = t.disc, tax_amount = t.tax, total = t.sub - t.disc + t.tax, updated_at = now()
       FROM t WHERE i.invoice_id = $1`,
    [invoiceId],
  );
}

async function lockInvoice(c: Db, invoiceId: string): Promise<{ status: InvoiceStatus; patient_id: string; correlation_id: string }> {
  const inv = await one<{ status: InvoiceStatus; patient_id: string; correlation_id: string }>(
    c,
    `SELECT status, patient_id, correlation_id FROM invoices WHERE invoice_id = $1 FOR UPDATE`,
    [invoiceId],
  );
  if (!inv) throw new BillingError("not_found", "That invoice does not exist.");
  return inv;
}

function requireDraft(status: InvoiceStatus): void {
  if (status !== "draft") throw new BillingError("wrong_state", "This invoice has been issued. Void it to change what is on it.");
}

// --- building an invoice -------------------------------------------------------------------------

export interface BillableItem {
  kind: "consultation" | "pharmacy";
  description: string;
  quantity: number;
  unit_price: number;
  source_ref: string;
}

/** What a visit has earned that is not yet on any live invoice. */
export async function unbilledForVisit(db: Db, visitId: string): Promise<BillableItem[]> {
  const fee = await many<BillableItem>(
    db,
    `SELECT 'consultation' AS kind, 'Consultation: ' || d.full_name || ' (' || dep.name || ')' AS description,
            1::float AS quantity, d.consultation_fee::float AS unit_price, 'visit-fee:' || v.visit_id AS source_ref
       FROM visits v JOIN doctors d ON d.doctor_id = v.doctor_id JOIN departments dep ON dep.department_id = v.department_id
      WHERE v.visit_id = $1 AND v.status <> 'cancelled' AND d.consultation_fee > 0
        AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.source_ref = 'visit-fee:' || v.visit_id)`,
    [visitId],
  );
  const medicines = await many<BillableItem>(
    db,
    `SELECT 'pharmacy' AS kind, m.name AS description, di.quantity::float AS quantity, di.unit_price::float AS unit_price,
            'dsi:' || di.dispensation_item_id AS source_ref
       FROM prescriptions rx
       JOIN dispensations x ON x.prescription_id = rx.prescription_id
       JOIN dispensation_items di ON di.dispensation_id = x.dispensation_id
       JOIN medicines m ON m.medicine_id = di.medicine_id
      WHERE rx.visit_id = $1
        AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.source_ref = 'dsi:' || di.dispensation_item_id)
      ORDER BY x.dispensed_at, m.name`,
    [visitId],
  );
  return [...fee, ...medicines];
}

export async function createInvoice(actor: Actor, opts: { patientId: string; visitId?: string | null }): Promise<string> {
  need(actor, "billing.manage", "Only billing can create invoices.");
  return tx(async (c) => {
    const patient = await one(c, `SELECT 1 FROM patients WHERE patient_id = $1`, [opts.patientId]);
    if (!patient) throw new BillingError("not_found", "That patient does not exist.");
    const id = newId("INV");
    await c.query(
      `INSERT INTO invoices (invoice_id, patient_id, visit_id, created_by, correlation_id) VALUES ($1, $2, $3, $4, $5)`,
      [id, opts.patientId, opts.visitId ?? null, actor.user_id, newCorrelationId()],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "invoice.created", recordId: id });
    return id;
  });
}

/**
 * A draft for a visit, pre-filled with the consultation fee and every medicine the pharmacy
 * dispensed that has not been billed. Returns the existing draft if there already is one.
 */
export async function createInvoiceForVisit(actor: Actor, visitId: string): Promise<{ invoiceId: string; existing: boolean }> {
  need(actor, "billing.manage", "Only billing can create invoices.");
  return tx(async (c) => {
    const visit = await one<{ patient_id: string }>(c, `SELECT patient_id FROM visits WHERE visit_id = $1 FOR UPDATE`, [visitId]);
    if (!visit) throw new BillingError("not_found", "That visit does not exist.");

    const draft = await one<{ invoice_id: string }>(c, `SELECT invoice_id FROM invoices WHERE visit_id = $1 AND status = 'draft' ORDER BY created_at LIMIT 1`, [visitId]);
    const items = await unbilledForVisit(c, visitId);

    let invoiceId = draft?.invoice_id;
    if (!invoiceId) {
      if (items.length === 0) throw new BillingError("nothing_to_bill", "There is nothing left to bill for this visit.");
      invoiceId = newId("INV");
      await c.query(
        `INSERT INTO invoices (invoice_id, patient_id, visit_id, created_by, correlation_id) VALUES ($1, $2, $3, $4, $5)`,
        [invoiceId, visit.patient_id, visitId, actor.user_id, newCorrelationId()],
      );
    }

    const next = await one<{ n: number }>(c, `SELECT COALESCE(max(position), 0)::int AS n FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);
    let position = next!.n;
    for (const it of items) {
      position += 1;
      await c.query(
        `INSERT INTO invoice_lines (line_id, invoice_id, position, kind, description, quantity, unit_price, line_total, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, round($6::numeric * $7::numeric, 2), $8)
         ON CONFLICT (source_ref) DO NOTHING`,
        [newId("LIN"), invoiceId, position, it.kind, it.description, it.quantity, it.unit_price, it.source_ref],
      );
    }
    await recalc(c, invoiceId);
    await audit(c, { workflow: "clinic", actor: "staff", action: draft ? "invoice.lines_added" : "invoice.created", recordId: invoiceId, details: { lines: items.length } });
    return { invoiceId, existing: !!draft };
  });
}

const LineSchema = z.object({
  description: z.string().trim().min(2, "Describe the charge.").max(160),
  quantity: z.preprocess((v) => Number(v), z.number({ error: "Enter a quantity." }).positive("Must be more than zero.").max(10000)),
  unit_price: z.preprocess((v) => Number(v), z.number({ error: "Enter a price." }).min(0, "Cannot be negative.").max(10_000_000)),
  tax_rate: z.preprocess((v) => (v === "" || v === undefined ? 0 : Number(v)), z.number().min(0).max(100)),
});

export async function addLine(
  actor: Actor,
  invoiceId: string,
  raw: { description: string; quantity: string | number; unit_price: string | number; tax_rate?: string | number; kind?: "service" | "bed" | "other" },
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  need(actor, "billing.manage", "Only billing can change an invoice.");
  const parsed = LineSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[String(i.path[0] ?? "_")] ??= i.message;
    return { ok: false, errors };
  }
  const v = parsed.data;
  await tx(async (c) => {
    const inv = await lockInvoice(c, invoiceId);
    requireDraft(inv.status);
    const next = await one<{ n: number }>(c, `SELECT COALESCE(max(position), 0)::int + 1 AS n FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);
    await c.query(
      `INSERT INTO invoice_lines (line_id, invoice_id, position, kind, description, quantity, unit_price, tax_rate, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, round($6::numeric * $7::numeric, 2))`,
      [newId("LIN"), invoiceId, next!.n, raw.kind ?? "service", v.description, v.quantity, v.unit_price, v.tax_rate],
    );
    await recalc(c, invoiceId);
  });
  return { ok: true };
}

export async function removeLine(actor: Actor, invoiceId: string, lineId: string): Promise<void> {
  need(actor, "billing.manage", "Only billing can change an invoice.");
  await tx(async (c) => {
    const inv = await lockInvoice(c, invoiceId);
    requireDraft(inv.status);
    await c.query(`DELETE FROM invoice_lines WHERE line_id = $1 AND invoice_id = $2`, [lineId, invoiceId]);
    await recalc(c, invoiceId);
  });
}

export async function setDiscount(
  actor: Actor,
  invoiceId: string,
  opts: { mode: "percent" | "amount"; value: number; reason: string },
): Promise<void> {
  need(actor, "billing.manage", "Only billing can change an invoice.");
  if (!Number.isFinite(opts.value) || opts.value < 0) throw new BillingError("validation", "Enter a discount of zero or more.");
  await tx(async (c) => {
    const inv = await lockInvoice(c, invoiceId);
    requireDraft(inv.status);
    const sub = await one<{ sub: number }>(c, `SELECT COALESCE(sum(line_total), 0)::float AS sub FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);
    const subtotal = sub!.sub;
    const amount = opts.mode === "percent" ? Math.round(subtotal * opts.value) / 100 : Math.round(opts.value * 100) / 100;
    if (amount > subtotal) throw new BillingError("validation", "The discount cannot be more than the bill.");
    if (amount > 0 && opts.reason.trim().length < 3) throw new BillingError("validation", "Give a reason for the discount.");
    if (subtotal > 0 && (amount / subtotal) * 100 > DISCOUNT_LIMIT_PERCENT && !can(actor.role, "billing.discount_large")) {
      throw new BillingError("discount_needs_admin", `Discounts above ${DISCOUNT_LIMIT_PERCENT}% need an administrator.`);
    }
    await c.query(`UPDATE invoices SET discount_amount = $2, discount_reason = $3 WHERE invoice_id = $1`, [
      invoiceId,
      amount,
      amount > 0 ? opts.reason.trim().slice(0, 200) : null,
    ]);
    await recalc(c, invoiceId);
    await audit(c, { workflow: "clinic", actor: "staff", action: "invoice.discount_set", recordId: invoiceId, details: { amount, reason: opts.reason } });
  });
}

/** Freezes the lines, numbers the invoice and starts the due-date clock. */
export async function issueInvoice(actor: Actor, invoiceId: string): Promise<{ invoiceNumber: string }> {
  need(actor, "billing.manage", "Only billing can issue an invoice.");
  return tx(async (c) => {
    const inv = await lockInvoice(c, invoiceId);
    requireDraft(inv.status);
    const lines = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = $1`, [invoiceId]);
    if (lines!.n === 0) throw new BillingError("nothing_to_bill", "Add at least one charge before issuing.");

    const year = istDateString().slice(0, 4);
    const seq = await one<{ n: number }>(c, `SELECT nextval('invoice_seq')::int AS n`);
    const number = `INV-${year}-${String(seq!.n).padStart(6, "0")}`;
    const total = await one<{ total: number }>(c, `SELECT total::float AS total FROM invoices WHERE invoice_id = $1`, [invoiceId]);
    const status: InvoiceStatus = total!.total === 0 ? "paid" : "issued";
    await c.query(
      `UPDATE invoices SET status = $2, invoice_number = $3, issued_at = now(), issued_by = $4, due_date = $5, updated_at = now()
        WHERE invoice_id = $1`,
      [invoiceId, status, number, actor.user_id, addDays(istDateString(), DEFAULT_DUE_DAYS)],
    );
    await audit(c, { workflow: "clinic", actor: "staff", action: "invoice.issued", recordId: invoiceId, correlationId: inv.correlation_id, details: { number } });
    return { invoiceNumber: number };
  });
}

// --- payments ------------------------------------------------------------------------------------

export interface PaymentInput {
  amount: number;
  method: PaymentMethod;
  reference?: string;
  /** Unique per payment form: submitting the same key twice records one payment. */
  idempotencyKey?: string;
}

export async function recordPayment(
  actor: Actor,
  invoiceId: string,
  input: PaymentInput,
): Promise<{ paymentId: string; receiptNumber: string; balance: number; duplicate: boolean }> {
  need(actor, "billing.collect", "Your role cannot take payments.");
  const amount = Math.round(input.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new BillingError("validation", "Enter the amount received.");
  if (!METHODS.includes(input.method)) throw new BillingError("validation", "Choose how it was paid.");
  if (input.method !== "cash" && input.reference !== undefined && input.reference.length > 80) {
    throw new BillingError("validation", "The reference is too long.");
  }

  return tx(async (c) => {
    if (input.idempotencyKey) {
      const prior = await one<{ payment_id: string; receipt_number: string; invoice_id: string }>(
        c,
        `SELECT payment_id, receipt_number, invoice_id FROM payments WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (prior) {
        const b = await one<{ balance: number }>(c, `SELECT (total - amount_paid)::float AS balance FROM invoices WHERE invoice_id = $1`, [prior.invoice_id]);
        return { paymentId: prior.payment_id, receiptNumber: prior.receipt_number, balance: b!.balance, duplicate: true };
      }
    }

    const inv = await lockInvoice(c, invoiceId);
    if (inv.status === "draft") throw new BillingError("wrong_state", "Issue the invoice before taking payment.");
    if (inv.status === "void") throw new BillingError("wrong_state", "This invoice was voided.");
    if (inv.status === "paid") throw new BillingError("wrong_state", "This invoice is already paid in full.");

    const row = await one<{ total: number; paid: number }>(c, `SELECT total::float AS total, amount_paid::float AS paid FROM invoices WHERE invoice_id = $1`, [invoiceId]);
    const balance = Math.round((row!.total - row!.paid) * 100) / 100;
    if (amount > balance) throw new BillingError("overpayment", `The balance is ₹${balance.toFixed(2)}; that is more than is owed.`);

    const year = istDateString().slice(0, 4);
    const seq = await one<{ n: number }>(c, `SELECT nextval('receipt_seq')::int AS n`);
    const receipt = `RCT-${year}-${String(seq!.n).padStart(6, "0")}`;
    const paymentId = newId("PAY");
    await c.query(
      `INSERT INTO payments (payment_id, invoice_id, kind, amount, method, reference, receipt_number, idempotency_key, received_by)
       VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7, $8)`,
      [paymentId, invoiceId, amount, input.method, input.reference?.trim() || null, receipt, input.idempotencyKey ?? null, actor.user_id],
    );
    const newPaid = Math.round((row!.paid + amount) * 100) / 100;
    const status: InvoiceStatus = newPaid >= row!.total ? "paid" : "partially_paid";
    await c.query(`UPDATE invoices SET amount_paid = $2, status = $3, updated_at = now() WHERE invoice_id = $1`, [invoiceId, newPaid, status]);
    const left = Math.round((row!.total - newPaid) * 100) / 100;

    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "payment.received",
      recordId: paymentId,
      correlationId: inv.correlation_id,
      details: { invoice_id: invoiceId, amount, method: input.method, balance: left },
    });

    const number = await one<{ invoice_number: string; patient_name: string }>(
      c,
      `SELECT i.invoice_number, p.full_name AS patient_name FROM invoices i JOIN patients p ON p.patient_id = i.patient_id WHERE i.invoice_id = $1`,
      [invoiceId],
    );
    const e = env();
    await enqueue(c, {
      type: JOB.messageSend,
      payload: {
        dedupe_key: `msg:${paymentId}:RECEIPT_01`,
        patient_id: inv.patient_id,
        template: "RECEIPT_01",
        workflow: "clinic",
        vars: {
          patient_name: number!.patient_name,
          hospital_name: e.HOSPITAL_NAME,
          amount: `₹${amount.toFixed(2)}`,
          invoice_number: number!.invoice_number,
          balance_line: left > 0 ? `Balance due: ₹${left.toFixed(2)}.` : "Your bill is paid in full.",
          hospital_contact: e.HOSPITAL_CONTACT,
        },
      },
      dedupeKey: `billing.receipt:${paymentId}`,
      correlationId: inv.correlation_id,
    });
    if (left > 0) {
      const due = await one<{ due_date: string }>(c, `SELECT due_date FROM invoices WHERE invoice_id = $1`, [invoiceId]);
      const when = due?.due_date ? istAt(due.due_date, 10) : new Date(Date.now() + DEFAULT_DUE_DAYS * 86_400_000);
      await enqueue(c, {
        type: JOB.invoiceDue,
        payload: { invoice_id: invoiceId },
        runAt: when > new Date() ? when : new Date(Date.now() + 3_600_000),
        dedupeKey: `billing.due:${invoiceId}`,
        correlationId: inv.correlation_id,
      });
    }
    return { paymentId, receiptNumber: receipt, balance: left, duplicate: false };
  });
}

export async function recordRefund(actor: Actor, invoiceId: string, opts: { amount: number; method: PaymentMethod; reason: string }): Promise<void> {
  need(actor, "billing.manage", "Only billing can issue a refund.");
  const amount = Math.round(opts.amount * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new BillingError("validation", "Enter the amount to refund.");
  if (opts.reason.trim().length < 3) throw new BillingError("validation", "Give a reason for the refund.");
  await tx(async (c) => {
    const inv = await lockInvoice(c, invoiceId);
    if (inv.status === "draft") throw new BillingError("wrong_state", "Nothing has been paid on a draft.");
    const row = await one<{ total: number; paid: number }>(c, `SELECT total::float AS total, amount_paid::float AS paid FROM invoices WHERE invoice_id = $1`, [invoiceId]);
    if (amount > row!.paid) throw new BillingError("validation", `Only ₹${row!.paid.toFixed(2)} has been paid.`);

    const seq = await one<{ n: number }>(c, `SELECT nextval('receipt_seq')::int AS n`);
    await c.query(
      `INSERT INTO payments (payment_id, invoice_id, kind, amount, method, reason, receipt_number, received_by)
       VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7)`,
      [newId("PAY"), invoiceId, amount, opts.method, opts.reason.trim().slice(0, 200), `RFD-${istDateString().slice(0, 4)}-${String(seq!.n).padStart(6, "0")}`, actor.user_id],
    );
    const newPaid = Math.round((row!.paid - amount) * 100) / 100;
    const status: InvoiceStatus = inv.status === "void" ? "void" : newPaid <= 0 ? "issued" : newPaid >= row!.total ? "paid" : "partially_paid";
    await c.query(`UPDATE invoices SET amount_paid = $2, status = $3, updated_at = now() WHERE invoice_id = $1`, [invoiceId, newPaid, status]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "payment.refunded", recordId: invoiceId, details: { amount, reason: opts.reason } });
  });
}

/**
 * Cancels an invoice. Refuses while money is held against it (refund first), and frees its
 * lines so the consultation and medicines can be billed again on a corrected invoice.
 */
export async function voidInvoice(actor: Actor, invoiceId: string, reason: string): Promise<void> {
  need(actor, "billing.manage", "Only billing can void an invoice.");
  if (reason.trim().length < 3) throw new BillingError("validation", "Give a reason for voiding.");
  await tx(async (c) => {
    const inv = await lockInvoice(c, invoiceId);
    if (inv.status === "void") throw new BillingError("wrong_state", "This invoice is already void.");
    const paid = await one<{ paid: number }>(c, `SELECT amount_paid::float AS paid FROM invoices WHERE invoice_id = $1`, [invoiceId]);
    if (paid!.paid > 0) throw new BillingError("has_payments", "Refund the payments before voiding this invoice.");
    await c.query(`UPDATE invoice_lines SET source_ref = NULL WHERE invoice_id = $1`, [invoiceId]);
    await c.query(
      `UPDATE invoices SET status = 'void', voided_by = $2, voided_at = now(), void_reason = $3, updated_at = now() WHERE invoice_id = $1`,
      [invoiceId, actor.user_id, reason.trim().slice(0, 200)],
    );
    await c.query(`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE dedupe_key = $1 AND status = 'queued'`, [`billing.due:${invoiceId}`]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "invoice.voided", recordId: invoiceId, correlationId: inv.correlation_id, details: { reason } });
  });
}

// --- listing and reports ---------------------------------------------------------------------------

export interface InvoiceListRow {
  invoice_id: string;
  invoice_number: string | null;
  status: InvoiceStatus;
  patient_id: string;
  patient_name: string;
  uhid: string;
  total: number;
  amount_paid: number;
  balance: number;
  due_date: string | null;
  issued_at: Date | null;
  created_at: Date;
}

export async function listInvoices(
  db: Db,
  opts: { view?: "open" | "unpaid" | "paid" | "draft" | "void" | "all"; q?: string; limit?: number } = {},
): Promise<InvoiceListRow[]> {
  const view = opts.view ?? "open";
  const like = opts.q?.trim() ? `%${opts.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  return many<InvoiceListRow>(
    db,
    `SELECT i.invoice_id, i.invoice_number, i.status, i.patient_id, p.full_name AS patient_name, p.uhid,
            i.total::float AS total, i.amount_paid::float AS amount_paid, (i.total - i.amount_paid)::float AS balance,
            i.due_date, i.issued_at, i.created_at
       FROM invoices i JOIN patients p ON p.patient_id = i.patient_id
      WHERE ($1 = 'all'
         OR ($1 = 'open' AND i.status IN ('draft', 'issued', 'partially_paid'))
         OR ($1 = 'unpaid' AND i.status IN ('issued', 'partially_paid'))
         OR ($1 = i.status))
        AND ($2::text IS NULL OR p.full_name ILIKE $2 OR p.uhid ILIKE $2 OR i.invoice_number ILIKE $2)
      ORDER BY i.created_at DESC
      LIMIT $3`,
    [view, like, opts.limit ?? 100],
  );
}

export interface VisitToBill {
  visit_id: string;
  token_number: number;
  patient_id: string;
  patient_name: string;
  uhid: string;
  doctor_name: string;
  status: string;
  unbilled_items: number;
  draft_invoice_id: string | null;
}

/** Today's visits that have charges nobody has put on an invoice yet. */
export async function visitsToBill(db: Db, date: string = istDateString()): Promise<VisitToBill[]> {
  return many<VisitToBill>(
    db,
    `SELECT v.visit_id, v.token_number, p.patient_id, p.full_name AS patient_name, p.uhid, d.full_name AS doctor_name, v.status,
            ( (CASE WHEN d.consultation_fee > 0 AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.source_ref = 'visit-fee:' || v.visit_id)
                    THEN 1 ELSE 0 END)
              + (SELECT count(*) FROM prescriptions rx
                   JOIN dispensations x ON x.prescription_id = rx.prescription_id
                   JOIN dispensation_items di ON di.dispensation_id = x.dispensation_id
                  WHERE rx.visit_id = v.visit_id
                    AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.source_ref = 'dsi:' || di.dispensation_item_id))
            )::int AS unbilled_items,
            (SELECT invoice_id FROM invoices i WHERE i.visit_id = v.visit_id AND i.status = 'draft' ORDER BY created_at LIMIT 1) AS draft_invoice_id
       FROM visits v
       JOIN patients p ON p.patient_id = v.patient_id
       JOIN doctors d ON d.doctor_id = v.doctor_id
      WHERE v.visit_date = $1 AND v.status <> 'cancelled'
      ORDER BY v.status = 'completed' DESC, v.checked_in_at`,
    [date],
  ).then((rows) => rows.filter((r) => r.unbilled_items > 0 || r.draft_invoice_id));
}

export interface DaySummary {
  date: string;
  collected: number;
  refunded: number;
  net: number;
  by_method: { method: PaymentMethod; amount: number; count: number }[];
  invoices_issued: number;
  billed: number;
  outstanding_total: number;
  outstanding_count: number;
}

export async function daySummary(db: Db, date: string = istDateString()): Promise<DaySummary> {
  const [start, end] = [istAt(date, 0), istAt(addDays(date, 1), 0)];
  const pay = await many<{ method: PaymentMethod; kind: string; amount: number; n: number }>(
    db,
    `SELECT method, kind, COALESCE(sum(amount), 0)::float AS amount, count(*)::int AS n
       FROM payments WHERE received_at >= $1 AND received_at < $2 GROUP BY method, kind`,
    [start, end],
  );
  const issued = await one<{ n: number; billed: number }>(
    db,
    `SELECT count(*)::int AS n, COALESCE(sum(total), 0)::float AS billed FROM invoices
      WHERE issued_at >= $1 AND issued_at < $2 AND status <> 'void'`,
    [start, end],
  );
  const open = await one<{ n: number; total: number }>(
    db,
    `SELECT count(*)::int AS n, COALESCE(sum(total - amount_paid), 0)::float AS total FROM invoices
      WHERE status IN ('issued', 'partially_paid')`,
  );
  const collected = pay.filter((p) => p.kind === "payment").reduce((s, p) => s + p.amount, 0);
  const refunded = pay.filter((p) => p.kind === "refund").reduce((s, p) => s + p.amount, 0);
  const methods = new Map<PaymentMethod, { amount: number; count: number }>();
  for (const p of pay) {
    const m = methods.get(p.method) ?? { amount: 0, count: 0 };
    m.amount += p.kind === "payment" ? p.amount : -p.amount;
    m.count += p.n;
    methods.set(p.method, m);
  }
  return {
    date,
    collected,
    refunded,
    net: Math.round((collected - refunded) * 100) / 100,
    by_method: [...methods.entries()].map(([method, v]) => ({ method, amount: Math.round(v.amount * 100) / 100, count: v.count })),
    invoices_issued: issued!.n,
    billed: issued!.billed,
    outstanding_total: open!.total,
    outstanding_count: open!.n,
  };
}

/** Reminder when an invoice is still unpaid at its due date. */
export async function sendInvoiceDueReminder(invoiceId: string): Promise<void> {
  const e = env();
  const inv = await getInvoice(pool(), invoiceId);
  if (!inv || inv.status === "void" || inv.status === "paid" || inv.status === "draft" || inv.balance <= 0) return;
  await sendTemplateMessage({
    dedupeKey: `msg:${invoiceId}:INVOICE_DUE_01`,
    patientId: inv.patient_id,
    template: "INVOICE_DUE_01",
    workflow: "clinic",
    correlationId: inv.correlation_id,
    vars: {
      patient_name: inv.patient_name,
      hospital_name: e.HOSPITAL_NAME,
      invoice_number: inv.invoice_number ?? "",
      balance: `₹${inv.balance.toFixed(2)}`,
      hospital_contact: e.HOSPITAL_CONTACT,
    },
  });
}
