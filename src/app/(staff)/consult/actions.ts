"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { requireStaff } from "@/server/auth/guard";
import {
  addAddendum,
  ConsultError,
  finaliseConsultation,
  recordVitals,
  saveDraft,
  type ConsultationInput,
  type ItemInput,
} from "@/server/clinic/consultation";
import { startConsultation, VisitError } from "@/server/clinic/visits";
import { one } from "@/lib/db";

export type FormState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; errors?: Record<string, string> };

function refresh(visitId: string) {
  revalidatePath(`/consult/${visitId}`);
  revalidatePath("/consult");
  revalidatePath("/reception");
}

async function guarded(fn: () => Promise<FormState>): Promise<FormState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConsultError || err instanceof VisitError) return { status: "error", message: err.message };
    throw err;
  }
}

/** Calls the next patient in and opens the workspace. Not for use inside useActionState. */
export async function callInAction(form: FormData): Promise<void> {
  const user = await requireStaff("consult.write");
  const visitId = String(form.get("visit_id") ?? "");
  const visit = await one<{ doctor_id: string }>(pool(), `SELECT doctor_id FROM visits WHERE visit_id = $1`, [visitId]);
  if (!visit || visit.doctor_id !== user.doctor_id) redirect("/consult");
  try {
    await startConsultation(visitId);
  } catch (err) {
    if (err instanceof VisitError && err.code === "doctor_busy") {
      // Carry on with the patient they already have, rather than showing an error page.
      const current = await one<{ visit_id: string }>(
        pool(),
        `SELECT visit_id FROM visits WHERE doctor_id = $1 AND status = 'in_consultation' ORDER BY consult_started_at LIMIT 1`,
        [user.doctor_id],
      );
      redirect(current ? `/consult/${current.visit_id}?busy=1` : "/consult");
    }
    throw err;
  }
  refresh(visitId);
  redirect(`/consult/${visitId}`);
}

export async function recordVitalsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireStaff("vitals.record");
  const visitId = String(form.get("visit_id") ?? "");
  return guarded(async () => {
    const r = await recordVitals(user, visitId, {
      bp_systolic: String(form.get("bp_systolic") ?? ""),
      bp_diastolic: String(form.get("bp_diastolic") ?? ""),
      pulse: String(form.get("pulse") ?? ""),
      temperature_c: String(form.get("temperature_c") ?? ""),
      spo2: String(form.get("spo2") ?? ""),
      resp_rate: String(form.get("resp_rate") ?? ""),
      weight_kg: String(form.get("weight_kg") ?? ""),
      height_cm: String(form.get("height_cm") ?? ""),
      notes: String(form.get("notes") ?? ""),
    });
    if (!r.ok) return { status: "error", message: Object.values(r.errors)[0] ?? "Check the readings.", errors: r.errors };
    refresh(visitId);
    return { status: "ok", message: "Vitals recorded." };
  });
}

function readConsultation(form: FormData): ConsultationInput {
  const items: ItemInput[] = [];
  for (let i = 0; i < 40; i++) {
    const name = form.get(`items.${i}.medicine_name`);
    if (name === null) break;
    items.push({
      medicine_name: String(name),
      dose_units: String(form.get(`items.${i}.dose_units`) ?? ""),
      frequency: String(form.get(`items.${i}.frequency`) ?? ""),
      duration_days: String(form.get(`items.${i}.duration_days`) ?? ""),
      timing: String(form.get(`items.${i}.timing`) ?? "any"),
      quantity: String(form.get(`items.${i}.quantity`) ?? ""),
      instructions: String(form.get(`items.${i}.instructions`) ?? ""),
    });
  }
  return {
    chief_complaint: String(form.get("chief_complaint") ?? ""),
    history: String(form.get("history") ?? ""),
    examination: String(form.get("examination") ?? ""),
    diagnosis: String(form.get("diagnosis") ?? ""),
    advice: String(form.get("advice") ?? ""),
    follow_up_date: String(form.get("follow_up_date") ?? ""),
    allergy_override_reason: String(form.get("allergy_override_reason") ?? ""),
    items,
  };
}

export async function saveConsultationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireStaff("consult.write");
  const visitId = String(form.get("visit_id") ?? "");
  const finish = form.get("intent") === "finish";

  return guarded(async () => {
    const input = readConsultation(form);
    const r = finish ? await finaliseConsultation(user, visitId, input) : await saveDraft(user, visitId, input);
    if (!r.ok) {
      return {
        status: "error",
        message: Object.values(r.errors ?? {})[0] ?? "Check the form.",
        errors: r.errors,
      };
    }
    refresh(visitId);
    if (finish) redirect("/consult?done=1");
    return { status: "ok", message: "Draft saved." };
  });
}

export async function addendumAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireStaff("consult.write");
  const visitId = String(form.get("visit_id") ?? "");
  return guarded(async () => {
    await addAddendum(user, String(form.get("consultation_id") ?? ""), String(form.get("note") ?? ""));
    refresh(visitId);
    return { status: "ok", message: "Note added to the record." };
  });
}
