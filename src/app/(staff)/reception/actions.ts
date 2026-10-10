"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { requireStaff } from "@/server/auth/guard";
import { registerPatient } from "@/server/clinic/patients";
import { cancelVisit, checkInAppointment, createVisit, setVisitPriority, VisitError } from "@/server/clinic/visits";

export type ReceptionResult = { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

export type RegisterState =
  | { status: "idle" }
  | { status: "error"; errors: Record<string, string>; values: Record<string, string> };

function refresh() {
  revalidatePath("/reception");
  revalidatePath("/");
}

async function run(fn: () => Promise<string>): Promise<ReceptionResult> {
  try {
    const message = await fn();
    refresh();
    return { status: "ok", message };
  } catch (err) {
    if (err instanceof VisitError) return { status: "error", message: err.message };
    throw err;
  }
}

export async function startVisitAction(_prev: ReceptionResult, form: FormData): Promise<ReceptionResult> {
  const user = await requireStaff("queue.manage");
  return run(async () => {
    const { visit, duplicate } = await createVisit({
      patientId: String(form.get("patient_id") ?? ""),
      doctorId: String(form.get("doctor_id") ?? ""),
      reason: String(form.get("reason") ?? ""),
      priority: form.get("priority") === "urgent" ? "urgent" : "normal",
      createdBy: user.user_id,
    });
    return duplicate ? `Already waiting: token ${visit.token_number}.` : `Token ${visit.token_number} issued.`;
  });
}

export async function checkInAction(_prev: ReceptionResult, form: FormData): Promise<ReceptionResult> {
  const user = await requireStaff("queue.manage");
  return run(async () => {
    const { visit } = await checkInAppointment(String(form.get("appointment_id") ?? ""), user.user_id);
    return `Checked in: token ${visit.token_number}.`;
  });
}

export async function cancelVisitAction(_prev: ReceptionResult, form: FormData): Promise<ReceptionResult> {
  await requireStaff("queue.manage");
  return run(async () => {
    await cancelVisit(String(form.get("visit_id") ?? ""), String(form.get("reason") ?? ""));
    return "Removed from the queue.";
  });
}

export async function setPriorityAction(_prev: ReceptionResult, form: FormData): Promise<ReceptionResult> {
  await requireStaff("queue.manage");
  return run(async () => {
    const urgent = form.get("priority") === "urgent";
    await setVisitPriority(String(form.get("visit_id") ?? ""), urgent ? "urgent" : "normal");
    return urgent ? "Marked urgent." : "Back to normal priority.";
  });
}

const FIELDS = [
  "full_name", "phone", "gender", "age", "date_of_birth", "city", "address", "blood_group", "allergies",
  "insurance_provider", "insurance_policy_no", "emergency_contact_name", "emergency_contact_phone",
  "whatsapp_consent", "doctor_id", "reason",
] as const;

export async function registerPatientAction(_prev: RegisterState, form: FormData): Promise<RegisterState> {
  const user = await requireStaff("patients.register");
  const values = Object.fromEntries(FIELDS.map((k) => [k, String(form.get(k) ?? "").trim()]));

  const result = await registerPatient(pool(), {
    full_name: values.full_name!,
    phone: values.phone!,
    gender: values.gender as "female" | "male" | "other",
    age: values.age,
    date_of_birth: values.date_of_birth,
    city: values.city,
    address: values.address,
    blood_group: (values.blood_group || null) as "A+" | null,
    allergies: values.allergies,
    insurance_provider: values.insurance_provider,
    insurance_policy_no: values.insurance_policy_no,
    emergency_contact_name: values.emergency_contact_name,
    emergency_contact_phone: values.emergency_contact_phone,
    whatsapp_consent: (values.whatsapp_consent || "unknown") as "yes" | "no" | "unknown",
  });
  if (!result.ok) return { status: "error", errors: result.errors, values };

  // Optionally straight into a queue, so registering a walk-in is one step.
  if (values.doctor_id) {
    try {
      await createVisit({
        patientId: result.patient.patient_id,
        doctorId: values.doctor_id,
        reason: values.reason,
        priority: form.get("priority") === "urgent" ? "urgent" : "normal",
        createdBy: user.user_id,
      });
    } catch (err) {
      if (err instanceof VisitError) return { status: "error", errors: { doctor_id: err.message }, values };
      throw err;
    }
  }
  refresh();
  redirect(`/reception?q=${encodeURIComponent(result.patient.uhid)}&${result.created ? "registered" : "matched"}=1`);
}
