"use server";

import { SERVICE_RECOVERY_THRESHOLD, submitFeedback } from "@/server/workflows/discharge";

export type FeedbackState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; serviceRecovery: boolean };

const MESSAGES: Record<string, string> = {
  already_submitted: "We have already received your feedback. Thank you.",
  expired: "This feedback link has expired.",
  unknown_token: "This feedback link is not valid.",
};

export async function submitFeedbackAction(_prev: FeedbackState, form: FormData): Promise<FeedbackState> {
  const token = String(form.get("token") ?? "");
  const rating = Number(form.get("rating"));
  const comment = String(form.get("comment") ?? "");

  if (!token) return { status: "error", message: "This feedback link is not valid." };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { status: "error", message: "Please select a rating." };
  }

  const outcome = await submitFeedback(token, rating, comment);
  if (outcome !== "recorded") return { status: "error", message: MESSAGES[outcome] ?? "Could not record feedback." };
  return { status: "done", serviceRecovery: rating <= SERVICE_RECOVERY_THRESHOLD };
}
