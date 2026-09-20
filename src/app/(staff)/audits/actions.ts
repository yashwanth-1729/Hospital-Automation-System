"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  AuditInputsSchema,
  AuditNotesSchema,
  AuditScoresSchema,
  createAudit,
  deleteAudit,
  saveAudit,
  SCORE_DIMENSIONS,
} from "@/server/audit";

export async function createAuditAction(formData: FormData) {
  const hospital = String(formData.get("hospital_name") ?? "").trim();
  if (!hospital) return;

  const id = await createAudit({
    hospital_name: hospital.slice(0, 120),
    city: String(formData.get("city") ?? "").trim().slice(0, 80) || null,
    contact_name: String(formData.get("contact_name") ?? "").trim().slice(0, 120) || null,
    contact_role: String(formData.get("contact_role") ?? "").trim().slice(0, 80) || null,
    conducted_by: String(formData.get("conducted_by") ?? "").trim().slice(0, 120) || null,
  });
  revalidatePath("/audits");
  redirect(`/audits/${id}`);
}

/** Saves the whole interview form: numbers, scores and notes together. */
export async function saveAuditAction(formData: FormData) {
  const id = String(formData.get("audit_id") ?? "");
  if (!id) return;
  const value = (name: string) => String(formData.get(name) ?? "");

  const inputs = AuditInputsSchema.parse(
    Object.fromEntries(Object.keys(AuditInputsSchema.shape).map((k) => [k, value(k) === "" ? undefined : value(k)])),
  );
  const scores = AuditScoresSchema.parse(
    Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d.key, value(d.key) === "" ? undefined : value(d.key)])),
  );
  const notes = AuditNotesSchema.parse({
    current_journey: value("current_journey"),
    systems_in_use: value("systems_in_use"),
    manual_steps: value("manual_steps"),
    constraints: value("constraints"),
  });

  await saveAudit(id, {
    hospital_name: value("hospital_name").trim().slice(0, 120) || undefined,
    city: value("city").trim().slice(0, 80) || null,
    contact_name: value("contact_name").trim().slice(0, 120) || null,
    contact_role: value("contact_role").trim().slice(0, 80) || null,
    conducted_by: value("conducted_by").trim().slice(0, 120) || null,
    status: value("status") === "final" ? "final" : "draft",
    inputs,
    scores,
    notes,
  });
  revalidatePath(`/audits/${id}`);
  revalidatePath(`/audits/${id}/report`);
  revalidatePath("/audits");
}

export async function deleteAuditAction(formData: FormData) {
  const id = String(formData.get("audit_id") ?? "");
  if (!id) return;
  await deleteAudit(id);
  revalidatePath("/audits");
  redirect("/audits");
}
