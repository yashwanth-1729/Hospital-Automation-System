"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/server/auth/guard";
import { remindPlan, setPlanStatus } from "@/server/care/care";

export async function remindNowAction(form: FormData): Promise<void> {
  await requireStaff("care.manage");
  await remindPlan(String(form.get("plan_id") ?? ""));
  revalidatePath("/care");
}

export async function planStatusAction(form: FormData): Promise<void> {
  const user = await requireStaff("care.manage");
  const status = String(form.get("status") ?? "");
  if (status !== "active" && status !== "paused" && status !== "ended") return;
  await setPlanStatus(user.user_id, String(form.get("plan_id") ?? ""), status);
  revalidatePath("/care");
}
