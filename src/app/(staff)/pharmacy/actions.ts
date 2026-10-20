"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/server/auth/guard";
import { one, pool } from "@/lib/db";
import { sendVisitToBilling } from "@/server/billing/invoices";
import { closePrescription, dispensePrescription, linkItemToMedicine, substituteItem } from "@/server/pharmacy/dispense";
import { adjustStock, PharmacyError, receiveStock, setReorderLevel } from "@/server/pharmacy/stock";

export type PharmacyState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; errors?: Record<string, string> };

function refresh(...paths: string[]) {
  for (const p of ["/pharmacy", "/pharmacy/stock", ...paths]) revalidatePath(p);
}

async function guarded(fn: () => Promise<PharmacyState>): Promise<PharmacyState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PharmacyError) return { status: "error", message: err.message };
    throw err;
  }
}

const inr = (n: number) => `₹${n.toFixed(2)}`;

export async function dispenseAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.dispense");
  const prescriptionId = String(form.get("prescription_id") ?? "");
  const lines: { itemId: string; quantity: number }[] = [];
  for (const [key, value] of form.entries()) {
    const m = /^qty\.(.+)$/.exec(key);
    if (m) lines.push({ itemId: m[1]!, quantity: Number(String(value).trim() || 0) });
  }
  return guarded(async () => {
    const r = await dispensePrescription(user, prescriptionId, lines);
    // Hand the bill to billing straight away. If that cannot be done the medicines are still dispensed.
    let billed = "";
    try {
      const rx = await one<{ visit_id: string | null }>(pool(), `SELECT visit_id FROM prescriptions WHERE prescription_id = $1`, [prescriptionId]);
      if (rx?.visit_id) {
        await sendVisitToBilling(user, rx.visit_id);
        billed = " Sent to billing.";
      }
    } catch {
      billed = " Billing can pick it up from the Billing page.";
    }
    refresh(`/pharmacy/${prescriptionId}`, "/billing");
    return {
      status: "ok",
      message: `Dispensed. Total ${inr(r.total)}.${r.prescriptionStatus === "dispensed" ? "" : " Part of the prescription is still outstanding."}${billed}`,
    };
  });
}

export async function linkItemAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.dispense");
  return guarded(async () => {
    await linkItemToMedicine(user, String(form.get("item_id") ?? ""), String(form.get("medicine_id") ?? ""));
    refresh(`/pharmacy/${String(form.get("prescription_id") ?? "")}`);
    return { status: "ok", message: "Matched." };
  });
}

export async function substituteAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.dispense");
  return guarded(async () => {
    await substituteItem(user, String(form.get("item_id") ?? ""), String(form.get("medicine_id") ?? ""));
    refresh(`/pharmacy/${String(form.get("prescription_id") ?? "")}`);
    return { status: "ok", message: "Swapped to the alternative." };
  });
}

export async function closeAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.dispense");
  const prescriptionId = String(form.get("prescription_id") ?? "");
  return guarded(async () => {
    await closePrescription(user, prescriptionId, String(form.get("note") ?? ""));
    refresh(`/pharmacy/${prescriptionId}`);
    return { status: "ok", message: "Prescription closed." };
  });
}

export async function receiveStockAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.stock");
  return guarded(async () => {
    const r = await receiveStock(user, {
      medicine_id: String(form.get("medicine_id") ?? ""),
      batch_number: String(form.get("batch_number") ?? ""),
      expiry_date: String(form.get("expiry_date") ?? ""),
      quantity: String(form.get("quantity") ?? ""),
      unit_cost: String(form.get("unit_cost") ?? ""),
      unit_price: String(form.get("unit_price") ?? ""),
      supplier: String(form.get("supplier") ?? ""),
    });
    if (!r.ok) return { status: "error", message: Object.values(r.errors)[0] ?? "Check the form.", errors: r.errors };
    refresh();
    return { status: "ok", message: r.toppedUp ? "Added to the existing batch." : "Stock received." };
  });
}

export async function adjustStockAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.stock");
  return guarded(async () => {
    await adjustStock(user, {
      batchId: String(form.get("batch_id") ?? ""),
      delta: Number(String(form.get("delta") ?? "")),
      reason: String(form.get("reason") ?? ""),
    });
    refresh();
    return { status: "ok", message: "Stock updated." };
  });
}

export async function reorderLevelAction(_prev: PharmacyState, form: FormData): Promise<PharmacyState> {
  const user = await requireStaff("pharmacy.stock");
  return guarded(async () => {
    await setReorderLevel(user, String(form.get("medicine_id") ?? ""), Number(String(form.get("level") ?? "")));
    refresh();
    return { status: "ok", message: "Reorder level saved." };
  });
}
