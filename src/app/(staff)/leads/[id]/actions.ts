"use server";

import { revalidatePath } from "next/cache";
import { bookLeadManually } from "@/server/workflows/scheduling";

export async function bookLeadAction(formData: FormData) {
  const leadId = String(formData.get("lead_id") ?? "");
  const slotId = String(formData.get("slot_id") ?? "");
  if (!leadId || !slotId) return;

  await bookLeadManually(leadId, slotId, "staff");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/exceptions");
  revalidatePath("/");
}
