"use server";

import { revalidatePath } from "next/cache";
import { closeFollowUp } from "@/server/workflows/no-show";

export async function closeFollowUpAction(formData: FormData) {
  const id = String(formData.get("followup_id") ?? "");
  const outcome = String(formData.get("outcome") ?? "") === "done" ? "done" : "cancelled";
  const note = String(formData.get("note") ?? "").trim().slice(0, 500) || "Closed by staff";
  if (!id) return;

  await closeFollowUp(id, outcome, note);
  revalidatePath("/follow-ups");
  revalidatePath("/");
}
