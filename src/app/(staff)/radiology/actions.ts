"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStaff } from "@/server/auth/guard";
import { cancelOrder, ImagingError, orderStudy, startStudy, submitReport, type Modality } from "@/server/radiology/imaging";

export type ImagingState = { status: "idle" } | { status: "ok"; message: string } | { status: "error"; message: string };

function refresh(orderId?: string, visitId?: string) {
  revalidatePath("/radiology");
  if (orderId) revalidatePath(`/radiology/${orderId}`);
  if (visitId) revalidatePath(`/consult/${visitId}`);
}

async function guarded(fn: () => Promise<ImagingState>): Promise<ImagingState> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ImagingError) return { status: "error", message: err.message };
    throw err;
  }
}

export async function orderStudyAction(_prev: ImagingState, form: FormData): Promise<ImagingState> {
  const user = await requireStaff("imaging.order");
  const visitId = String(form.get("visit_id") ?? "");
  return guarded(async () => {
    await orderStudy(user, {
      visitId,
      study: String(form.get("study") ?? ""),
      modality: String(form.get("modality") ?? "") as Modality,
      indication: String(form.get("indication") ?? ""),
      priority: form.get("priority") === "urgent" ? "urgent" : "routine",
    });
    refresh(undefined, visitId);
    return { status: "ok", message: "Ordered. Radiology can see it now." };
  });
}

export async function cancelOrderAction(_prev: ImagingState, form: FormData): Promise<ImagingState> {
  const user = await requireStaff("imaging.order");
  const visitId = String(form.get("visit_id") ?? "");
  return guarded(async () => {
    await cancelOrder(user, String(form.get("order_id") ?? ""), String(form.get("reason") ?? "Not needed"));
    refresh(undefined, visitId);
    return { status: "ok", message: "Cancelled." };
  });
}

export async function startStudyAction(form: FormData): Promise<void> {
  const user = await requireStaff("imaging.report");
  const orderId = String(form.get("order_id") ?? "");
  try {
    await startStudy(user, orderId);
  } catch (err) {
    if (!(err instanceof ImagingError)) throw err;
  }
  refresh(orderId);
  redirect(`/radiology/${orderId}`);
}

export async function reportAction(_prev: ImagingState, form: FormData): Promise<ImagingState> {
  const user = await requireStaff("imaging.report");
  const orderId = String(form.get("order_id") ?? "");
  const result = await guarded(async () => {
    await submitReport(user, orderId, { findings: String(form.get("findings") ?? ""), impression: String(form.get("impression") ?? "") });
    refresh(orderId);
    return { status: "ok", message: "Report saved and sent to the doctor." } as const;
  });
  if (result.status === "ok") redirect("/radiology?reported=1");
  return result;
}
