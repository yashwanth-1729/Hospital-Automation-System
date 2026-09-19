"use client";

import { useActionState } from "react";
import { submitEnquiry, type EnquiryState } from "./actions";

const inputClass =
  "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary aria-[invalid=true]:border-danger";

function FieldError({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-danger">{message}</p> : null;
}

export function EnquiryForm({ departments, minDate, maxDate }: { departments: { department_id: string; name: string }[]; minDate: string; maxDate: string }) {
  const [state, action, pending] = useActionState<EnquiryState, FormData>(submitEnquiry, { status: "idle" });

  if (state.status === "done") {
    return (
      <div className="rounded-xl border border-ok/30 bg-ok-soft p-6 text-center" role="status">
        <div className="text-lg font-semibold text-ok">Thank you. We have received your enquiry.</div>
        <p className="mt-2 text-sm text-muted">
          You will receive a WhatsApp message shortly. Your reference is <span className="font-mono">{state.reference}</span>.
        </p>
        <a href="/enquiry" className="mt-4 inline-block text-sm text-primary underline">Send another enquiry</a>
      </div>
    );
  }

  const errors = state.status === "error" ? state.errors : {};
  const v = state.status === "error" ? state.values : {};

  return (
    <form action={action} className="space-y-4" noValidate>
      {errors._ && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{errors._}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Full name
          <input name="full_name" required autoComplete="name" defaultValue={v.full_name} aria-invalid={!!errors.full_name} className={inputClass} />
          <FieldError message={errors.full_name} />
        </label>
        <label className="block text-sm font-medium">
          Mobile number
          <input name="phone" required type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" defaultValue={v.phone} aria-invalid={!!errors.phone} className={inputClass} />
          <FieldError message={errors.phone} />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Department
          <select name="department" defaultValue={v.department ?? ""} className={inputClass}>
            <option value="">Not sure</option>
            {departments.map((d) => (
              <option key={d.department_id} value={d.name}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Preferred date
          <input name="preferred_date" type="date" required min={minDate} max={maxDate} defaultValue={v.preferred_date} aria-invalid={!!errors.preferred_date} className={inputClass} />
          <FieldError message={errors.preferred_date} />
        </label>
      </div>

      <label className="block text-sm font-medium">
        How can we help?
        <textarea name="enquiry_text" required rows={4} maxLength={2000} defaultValue={v.enquiry_text} aria-invalid={!!errors.enquiry_text} className={inputClass} placeholder="For example: I would like to book a consultation." />
        <FieldError message={errors.enquiry_text} />
      </label>

      {/* Honeypot for bots; hidden from people and assistive tech. */}
      <div aria-hidden className="absolute -left-[9999px]">
        <input name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <label className="flex items-start gap-2 text-sm text-muted">
        <input type="checkbox" name="consent" defaultChecked className="mt-0.5" />
        <span>I agree to receive appointment confirmations and reminders on WhatsApp for this enquiry.</span>
      </label>

      <button disabled={pending} className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Sending…" : "Request appointment"}
      </button>
      <p className="text-center text-xs text-muted">
        This form is for appointments and general enquiries. In a medical emergency, call 108 immediately.
      </p>
    </form>
  );
}
