"use client";

import { useActionState, useState } from "react";
import { submitFeedbackAction, type FeedbackState } from "./actions";

const RATINGS = [
  { value: 5, label: "Excellent" },
  { value: 4, label: "Good" },
  { value: 3, label: "Okay" },
  { value: 2, label: "Poor" },
  { value: 1, label: "Very poor" },
];

export function FeedbackForm({ token, patientName }: { token: string; patientName: string }) {
  const [state, action, pending] = useActionState<FeedbackState, FormData>(submitFeedbackAction, { status: "idle" });
  const [rating, setRating] = useState<number | null>(null);

  if (state.status === "done") {
    return (
      <div className="text-center" role="status">
        <div className="text-lg font-semibold text-ok">Thank you for your feedback.</div>
        <p className="mt-2 text-sm text-muted">
          {state.serviceRecovery
            ? "We are sorry your experience was not better. A member of our team will contact you shortly."
            : "We are glad to hear it. Your response helps our team improve."}
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm">Hello {patientName}, please rate your experience.</p>

      <fieldset>
        <legend className="sr-only">Rating</legend>
        <div className="space-y-2">
          {RATINGS.map((r) => (
            <label
              key={r.value}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                rating === r.value ? "border-primary bg-primary-soft text-primary" : "border-border hover:border-primary/40"
              }`}
            >
              <input
                type="radio"
                name="rating"
                value={r.value}
                required
                checked={rating === r.value}
                onChange={() => setRating(r.value)}
                className="accent-[var(--primary)]"
              />
              <span className="font-medium">{r.value}</span>
              <span className="text-muted">{r.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm font-medium">
        Anything you would like us to know? (optional)
        <textarea
          name="comment"
          rows={3}
          maxLength={1000}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
          placeholder="Your comments help us improve."
        />
      </label>

      {state.status === "error" && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>}

      <button
        disabled={pending}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Sending…" : "Submit feedback"}
      </button>
    </form>
  );
}
