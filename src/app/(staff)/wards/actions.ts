"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/guard";
import { createInvoiceForAdmission, BillingError } from "@/server/billing/invoices";
import { addWard, admitPatient, dischargeAdmission, IpdError, markBedReady, setBedMaintenance, transferBed } from "@/server/ipd/admissions";

export type WardState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

function refresh(admissionId?: string) {
  revalidatePath("/wards");
  revalidatePath("/");
  if (admissionId) revalidatePath(`/admissions/${admissionId}`);
}

async function guarded(fn: () => Promise<WardState>): Promise<WardState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IpdError || err instanceof BillingError) return { status: "error", message: err.message };
    throw err;
  }
}

/** Admits and opens the admission. Redirects on success, so it is used with a plain form. */
export async function admitAction(_prev: WardState, form: FormData): Promise<WardState> {
  const user = await requireStaff("ipd.admit");
  let admissionId: string;
  try {
    ({ admissionId } = await admitPatient(user, {
      patientId: String(form.get("patient_id") ?? ""),
      bedId: String(form.get("bed_id") ?? ""),
      doctorId: String(form.get("doctor_id") ?? ""),
      reason: String(form.get("reason") ?? ""),
      expectedDischarge: String(form.get("expected_discharge") ?? ""),
    }));
  } catch (err) {
    if (err instanceof IpdError) return { status: "error", message: err.message };
    throw err;
  }
  refresh();
  redirect(`/admissions/${admissionId}`);
}

export async function transferAction(_prev: WardState, form: FormData): Promise<WardState> {
  const user = await requireStaff("ipd.transfer");
  const admissionId = String(form.get("admission_id") ?? "");
  return guarded(async () => {
    await transferBed(user, admissionId, String(form.get("bed_id") ?? ""));
    refresh(admissionId);
    return { status: "ok", message: "Patient moved. The old bed is marked for cleaning." };
  });
}

export async function dischargeAction(_prev: WardState, form: FormData): Promise<WardState> {
  const user = await requireStaff("ipd.discharge");
  const admissionId = String(form.get("admission_id") ?? "");
  return guarded(async () => {
    await dischargeAdmission(user, admissionId, {
      followUpDate: String(form.get("follow_up_date") ?? ""),
      approvedBy: String(form.get("approved_by") ?? ""),
    });
    refresh(admissionId);
    return { status: "ok", message: "Discharged. The follow-up reminder and feedback request are scheduled." };
  });
}

export async function bedReadyAction(_prev: WardState, form: FormData): Promise<WardState> {
  const user = await requireStaff("ipd.beds");
  return guarded(async () => {
    await markBedReady(user, String(form.get("bed_id") ?? ""));
    refresh();
    return { status: "ok", message: "Ready." };
  });
}

export async function maintenanceAction(_prev: WardState, form: FormData): Promise<WardState> {
  const user = await requireStaff("ipd.beds");
  return guarded(async () => {
    await setBedMaintenance(user, String(form.get("bed_id") ?? ""), form.get("on") === "true");
    refresh();
    return { status: "ok", message: "Updated." };
  });
}

export async function addWardAction(_prev: WardState, form: FormData): Promise<WardState> {
  const user = await requireStaff("ipd.configure");
  return guarded(async () => {
    await addWard(user, {
      name: String(form.get("name") ?? ""),
      kind: String(form.get("kind") ?? ""),
      dailyRate: Number(String(form.get("daily_rate") ?? "")),
      beds: Number(String(form.get("beds") ?? "")),
    });
    refresh();
    return { status: "ok", message: "Ward added." };
  });
}

export async function billAdmissionAction(form: FormData): Promise<void> {
  const user = await requireStaff("billing.manage");
  let id: string;
  try {
    id = (await createInvoiceForAdmission(user, String(form.get("admission_id") ?? ""))).invoiceId;
  } catch (err) {
    if (err instanceof BillingError) redirect(`/billing?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath("/billing");
  redirect(`/billing/${id}`);
}
