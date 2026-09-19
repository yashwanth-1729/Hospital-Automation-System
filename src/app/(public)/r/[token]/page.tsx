import { connection } from "next/server";
import { env } from "@/lib/env";
import { getFeedbackRequest } from "@/server/workflows/discharge";
import { FeedbackForm } from "./form";

export const metadata = { title: "Share your feedback" };

export default async function FeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const request = await getFeedbackRequest(token);
  const e = env();

  const message = !request
    ? "This feedback link is not valid. Please check the link in your message."
    : request.expired
      ? "This feedback link has expired. Thank you for your interest."
      : request.responded_at
        ? "Thank you, we have already received your feedback."
        : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary-soft to-bg">
      <div className="mx-auto max-w-lg px-4 py-12">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-primary text-xl font-bold text-white">
            {e.HOSPITAL_NAME.charAt(0)}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{e.HOSPITAL_NAME}</h1>
          {!message && <p className="mt-1 text-sm text-muted">How was your recent experience with us?</p>}
        </header>

        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          {message ? (
            <p className="text-center text-sm text-muted">{message}</p>
          ) : (
            <FeedbackForm token={token} patientName={request!.patient_name} />
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted">
          Please do not share medical details here. For medical questions, call {e.HOSPITAL_CONTACT}.
        </p>
      </div>
    </div>
  );
}
