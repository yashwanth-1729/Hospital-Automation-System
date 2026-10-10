"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/guard";
import {
  addLine,
  BillingError,
  createInvoice,
  createInvoiceForVisit,
  issueInvoice,
  METHODS,
  recordPayment,
  recordRefund,
  removeLine,
  setDiscount,
  voidInvoice,
  type PaymentMethod,
} from "@/server/billing/invoices";

export type BillingState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; errors?: Record<string, string> };

function refresh(invoiceId?: string) {
  revalidatePath("/billing");
  if (invoiceId) {
    revalidatePath(`/billing/${invoiceId}`);
    revalidatePath(`/billing/${invoiceId}/print`);
  }
}

async function guarded(fn: () => Promise<BillingState>): Promise<BillingState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BillingError) return { status: "error", message: err.message };
    throw err;
  }
}

const method = (v: FormDataEntryValue | null): PaymentMethod => (METHODS.includes(String(v) as PaymentMethod) ? (String(v) as PaymentMethod) : "cash");

/** Opens (or continues) the draft for a visit. Redirects, so not for useActionState. */
export async function createForVisitAction(form: FormData): Promise<void> {
  const user = await requireStaff("billing.manage");
  let id: string;
  try {
    id = (await createInvoiceForVisit(user, String(form.get("visit_id") ?? ""))).invoiceId;
  } catch (err) {
    if (err instanceof BillingError) redirect(`/billing?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  refresh();
  redirect(`/billing/${id}`);
}

export async function createBlankAction(form: FormData): Promise<void> {
  const user = await requireStaff("billing.manage");
  let id: string;
  try {
    id = await createInvoice(user, { patientId: String(form.get("patient_id") ?? "") });
  } catch (err) {
    if (err instanceof BillingError) redirect(`/billing?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  refresh();
  redirect(`/billing/${id}`);
}

export async function addLineAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.manage");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    const r = await addLine(user, invoiceId, {
      description: String(form.get("description") ?? ""),
      quantity: String(form.get("quantity") ?? "1"),
      unit_price: String(form.get("unit_price") ?? ""),
      tax_rate: String(form.get("tax_rate") ?? "0"),
    });
    if (!r.ok) return { status: "error", message: Object.values(r.errors)[0] ?? "Check the charge.", errors: r.errors };
    refresh(invoiceId);
    return { status: "ok", message: "Added." };
  });
}

export async function removeLineAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.manage");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    await removeLine(user, invoiceId, String(form.get("line_id") ?? ""));
    refresh(invoiceId);
    return { status: "ok", message: "Removed." };
  });
}

export async function discountAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.manage");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    await setDiscount(user, invoiceId, {
      mode: form.get("mode") === "amount" ? "amount" : "percent",
      value: Number(String(form.get("value") ?? "0") || 0),
      reason: String(form.get("reason") ?? ""),
    });
    refresh(invoiceId);
    return { status: "ok", message: "Discount applied." };
  });
}

export async function issueAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.manage");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    const r = await issueInvoice(user, invoiceId);
    refresh(invoiceId);
    return { status: "ok", message: `Issued as ${r.invoiceNumber}.` };
  });
}

export async function payAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.collect");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    const r = await recordPayment(user, invoiceId, {
      amount: Number(String(form.get("amount") ?? "")),
      method: method(form.get("method")),
      reference: String(form.get("reference") ?? ""),
      idempotencyKey: String(form.get("idempotency_key") ?? "") || undefined,
    });
    refresh(invoiceId);
    return {
      status: "ok",
      message: `Receipt ${r.receiptNumber}. ${r.balance > 0 ? `Balance ₹${r.balance.toFixed(2)}.` : "Paid in full."}`,
    };
  });
}

export async function refundAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.manage");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    await recordRefund(user, invoiceId, {
      amount: Number(String(form.get("amount") ?? "")),
      method: method(form.get("method")),
      reason: String(form.get("reason") ?? ""),
    });
    refresh(invoiceId);
    return { status: "ok", message: "Refund recorded." };
  });
}

export async function voidAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  const user = await requireStaff("billing.manage");
  const invoiceId = String(form.get("invoice_id") ?? "");
  return guarded(async () => {
    await voidInvoice(user, invoiceId, String(form.get("reason") ?? ""));
    refresh(invoiceId);
    return { status: "ok", message: "Invoice voided." };
  });
}
