"use client";

import { useActionState } from "react";
import { recordDischargeAction, type DischargeState } from "./actions";

const inputClass = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

function Err({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-danger">{message}</p> : null;
}

export function DischargeForm({ departments }: { departments: { department_id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<DischargeState, FormData>(recordDischargeAction, { status: "idle" });
  const errors = state.status === "error" ? state.errors : {};

  return (
    <form action={action} className="grid gap-4 p-4 sm:grid-cols-2">
      {state.status === "done" && (
        <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok sm:col-span-2" role="status">
          Discharge recorded ({state.dischargeId}). The follow-up workflow has started.
        </p>
      )}

      <label className="block text-sm font-medium">
        Patient name
        <input name="full_name" required className={inputClass} />
        <Err message={errors.full_name} />
      </label>
      <label className="block text-sm font-medium">
        Mobile number
        <input name="phone" required placeholder="98765 43210" className={inputClass} />
        <Err message={errors.phone} />
      </label>
      <label className="block text-sm font-medium">
        Department
        <select name="department" className={inputClass} defaultValue="">
          <option value="">—</option>
          {departments.map((d) => (
            <option key={d.department_id} value={d.name}>{d.name}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        Encounter / IP number
        <input name="encounter_id" placeholder="IP-2026-0912" className={inputClass} />
      </label>

      <fieldset className="rounded-lg border border-border p-3 sm:col-span-2">
        <legend className="px-1 text-xs font-medium tracking-wide text-muted uppercase">Clinician-approved follow-up</legend>
        <p className="mb-3 text-xs text-muted">
          The system never decides a follow-up date. Leave this blank if the doctor has not confirmed one, and it will be
          queued for the department to complete.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm font-medium">
            Approved date
            <input name="approved_followup_date" type="date" className={inputClass} />
            <Err message={errors.approved_followup_date} />
          </label>
          <label className="block text-sm font-medium">
            Time window
            <input name="approved_followup_window" placeholder="Morning OPD" className={inputClass} />
          </label>
          <label className="block text-sm font-medium">
            Approved by
            <input name="approved_by" placeholder="Dr. Ananya Rao" className={inputClass} />
            <Err message={errors.approved_by} />
          </label>
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm text-muted sm:col-span-2">
        <input type="checkbox" name="consent" defaultChecked className="mt-0.5" />
        <span>Patient consented to follow-up messages on WhatsApp.</span>
      </label>

      <div className="sm:col-span-2">
        <button disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
          {pending ? "Recording…" : "Record discharge"}
        </button>
      </div>
    </form>
  );
}
