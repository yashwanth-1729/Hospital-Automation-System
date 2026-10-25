"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/server/auth/guard";
import { LabError, markReportReady, markReviewed } from "@/server/care/labs";

export async function reviewedAction(form: FormData): Promise<void> {
  const user = await requireStaff("labs.review");
  try {
    await markReviewed(user.user_id, String(form.get("diagnostic_id") ?? ""));
  } catch (err) {
    if (!(err instanceof LabError)) throw err;
  }
  revalidatePath("/labs");
}

export async function readyAction(form: FormData): Promise<void> {
  const user = await requireStaff("care.manage");
  const flag = form.get("flag") === "abnormal" ? "abnormal" : "normal";
  try {
    await markReportReady(user.user_id, String(form.get("diagnostic_id") ?? ""), flag);
  } catch (err) {
    if (!(err instanceof LabError)) throw err;
  }
  revalidatePath("/labs");
}
