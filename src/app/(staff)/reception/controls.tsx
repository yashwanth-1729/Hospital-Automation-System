"use client";

import { useActionState } from "react";
import type { DoctorOption } from "@/server/clinic/directory";
import { startVisitAction, type ReceptionResult } from "./actions";

const IDLE: ReceptionResult = { status: "idle" };

type Tone = "primary" | "danger" | "neutral";
const TONE: Record<Tone, string> = {
  primary: "border-primary bg-primary text-white hover:opacity-90",
  danger: "border-border hover:border-danger hover:text-danger",
  neutral: "border-border hover:border-primary hover:text-primary",
};

function Result({ state }: { state: ReceptionResult }) {
  if (state.status === "error") return <p role="alert" className="mt-1 max-w-56 text-xs text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="mt-1 max-w-56 text-xs text-ok">{state.message}</p>;
  return null;
}

/** One small form: hidden fields plus a button, with the outcome shown beside it. */
export function ActionButton({
  action,
  fields,
  label,
  tone = "neutral",
}: {
  action: (prev: ReceptionResult, form: FormData) => Promise<ReceptionResult>;
  fields: Record<string, string>;
  label: string;
  tone?: Tone;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <form action={formAction} className="inline-block">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button disabled={pending} className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${TONE[tone]}`}>
        {pending ? "…" : label}
      </button>
      <Result state={state} />
    </form>
  );
}

export function StartVisitForm({ patientId, doctors }: { patientId: string; doctors: DoctorOption[] }) {
  const [state, action, pending] = useActionState(startVisitAction, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="patient_id" value={patientId} />
      <label className="text-xs font-medium">
        Doctor
        <select name="doctor_id" required defaultValue="" className="mt-1 block rounded-lg border border-border bg-surface px-2 py-1.5 text-sm">
          <option value="" disabled>Choose…</option>
          {doctors.map((d) => (
            <option key={d.doctor_id} value={d.doctor_id}>{d.full_name} · {d.department}</option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium">
        Reason
        <input name="reason" maxLength={300} placeholder="Optional" className="mt-1 block w-44 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm" />
      </label>
      <label className="flex items-center gap-1.5 pb-2 text-xs">
        <input type="checkbox" name="priority" value="urgent" /> Urgent
      </label>
      <button disabled={pending} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Issuing…" : "Issue token"}
      </button>
      <Result state={state} />
    </form>
  );
}
