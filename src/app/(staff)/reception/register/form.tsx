"use client";

import { useActionState } from "react";
import type { DoctorOption } from "@/server/clinic/directory";
import { registerPatientAction, type RegisterState } from "../actions";

const input = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary aria-[invalid=true]:border-danger";
const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

function Err({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-danger">{message}</p> : null;
}

export function RegisterForm({ doctors }: { doctors: DoctorOption[] }) {
  const [state, action, pending] = useActionState<RegisterState, FormData>(registerPatientAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};
  const v = state.status === "error" ? state.values : {};

  return (
    <form action={action} className="space-y-6" noValidate>
      {errors._ && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{errors._}</p>}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Patient</legend>
        <label className="block text-sm font-medium sm:col-span-2">
          Full name
          <input name="full_name" required autoFocus defaultValue={v.full_name} aria-invalid={!!errors.full_name} className={input} />
          <Err message={errors.full_name} />
        </label>
        <label className="block text-sm font-medium">
          Mobile number
          <input name="phone" type="tel" inputMode="tel" required placeholder="98765 43210" defaultValue={v.phone} aria-invalid={!!errors.phone} className={input} />
          <Err message={errors.phone} />
        </label>
        <label className="block text-sm font-medium">
          Gender
          <select name="gender" required defaultValue={v.gender ?? ""} aria-invalid={!!errors.gender} className={input}>
            <option value="" disabled>Choose…</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </select>
          <Err message={errors.gender} />
        </label>
        <label className="block text-sm font-medium">
          Age (years)
          <input name="age" type="number" min={0} max={120} inputMode="numeric" defaultValue={v.age} aria-invalid={!!errors.age} className={input} />
          <Err message={errors.age} />
        </label>
        <label className="block text-sm font-medium">
          or date of birth
          <input name="date_of_birth" type="date" defaultValue={v.date_of_birth} aria-invalid={!!errors.date_of_birth} className={input} />
          <Err message={errors.date_of_birth} />
        </label>
        <label className="block text-sm font-medium">
          City
          <input name="city" defaultValue={v.city} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Blood group
          <select name="blood_group" defaultValue={v.blood_group ?? ""} className={input}>
            <option value="">Not known</option>
            {BLOOD.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium sm:col-span-2">
          Address
          <input name="address" defaultValue={v.address} className={input} />
        </label>
        <label className="block text-sm font-medium sm:col-span-2">
          Known allergies
          <input name="allergies" defaultValue={v.allergies} placeholder="For example: penicillin. Leave empty if none are known." className={input} />
          <span className="mt-1 block text-xs font-normal text-muted">Shown to the doctor and the pharmacist on every visit.</span>
        </label>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Contact and insurance</legend>
        <label className="block text-sm font-medium">
          Emergency contact
          <input name="emergency_contact_name" defaultValue={v.emergency_contact_name} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Their number
          <input name="emergency_contact_phone" type="tel" defaultValue={v.emergency_contact_phone} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Insurance provider
          <input name="insurance_provider" defaultValue={v.insurance_provider} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Policy number
          <input name="insurance_policy_no" defaultValue={v.insurance_policy_no} className={input} />
        </label>
        <label className="block text-sm font-medium sm:col-span-2">
          Send appointment and visit updates on WhatsApp?
          <select name="whatsapp_consent" defaultValue={v.whatsapp_consent ?? "unknown"} className={input}>
            <option value="unknown">Not asked</option>
            <option value="yes">Yes, the patient agrees</option>
            <option value="no">No, the patient declined</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="grid gap-4 rounded-xl border border-border bg-surface-2 p-4 sm:grid-cols-2">
        <legend className="px-1 text-xs font-semibold tracking-wide text-muted uppercase">Seeing a doctor today? (optional)</legend>
        <label className="block text-sm font-medium">
          Doctor
          <select name="doctor_id" defaultValue={v.doctor_id ?? ""} aria-invalid={!!errors.doctor_id} className={input}>
            <option value="">Just register, no visit</option>
            {doctors.map((d) => (
              <option key={d.doctor_id} value={d.doctor_id}>{d.full_name} · {d.department}</option>
            ))}
          </select>
          <Err message={errors.doctor_id} />
        </label>
        <label className="block text-sm font-medium">
          Reason for visit
          <input name="reason" maxLength={300} defaultValue={v.reason} className={input} />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="priority" value="urgent" /> Urgent: take before others waiting
        </label>
      </fieldset>

      <button disabled={pending} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Saving…" : "Register patient"}
      </button>
    </form>
  );
}
