"use server";

import { revalidatePath } from "next/cache";
import { generateDailySummary } from "@/server/ai/summary";
import { getReport, summaryMetrics } from "@/server/reports";
import { requireStaff } from "@/server/auth/guard";

export async function generateSummaryAction(formData: FormData) {
  await requireStaff("reports.view");
  const days = Number(formData.get("days") ?? 7);
  const report = await getReport(Number.isFinite(days) && days > 0 ? days : 7);
  await generateDailySummary(summaryMetrics(report), { force: true });
  revalidatePath("/reports");
}
