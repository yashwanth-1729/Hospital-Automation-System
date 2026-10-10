"use server";

import { revalidatePath } from "next/cache";
import { recordDischarge } from "@/server/workflows/discharge";
import { requireStaff } from "@/server/auth/guard";

export type DischargeState =
  | { status: "idle" }
  | { status: "error"; errors: Record<string, string> }
  | { status: "done"; dischargeId: string };

export async function recordDischargeAction(_prev: DischargeState, form: FormData): Promise<DischargeState> {
  await requireStaff("discharges.manage");
  const result = await recordDischarge({
    full_name: String(form.get("full_name") ?? ""),
    phone: String(form.get("phone") ?? ""),
    encounter_id: String(form.get("encounter_id") ?? "") || null,
    department: String(form.get("department") ?? "") || null,
    approved_followup_date: String(form.get("approved_followup_date") ?? "") || null,
    approved_followup_window: String(form.get("approved_followup_window") ?? "") || null,
    approved_by: String(form.get("approved_by") ?? "") || null,
    consent: form.get("consent") === "on",
    source: "staff",
  });
  if (!result.ok) return { status: "error", errors: result.errors };

  revalidatePath("/discharges");
  revalidatePath("/");
  return { status: "done", dischargeId: result.dischargeId };
}
