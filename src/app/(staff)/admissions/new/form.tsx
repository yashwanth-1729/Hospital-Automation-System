"use client";

import { useActionState, useState } from "react";
import { admitAction, type WardState } from "../../wards/actions";

const input = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

export function AdmitForm({
  patientId,
  beds,
  doctors,
  initialBed,
}: {
  patientId: string;
  beds: { bed_id: string; label: string; ward_name: string; daily_rate: number }[];
  doctors: { doctor_id: string; full_name: string; department: string }[];
  initialBed?: string;
}) {
  const [v, setV] = useState({
    bed_id: beds.some((b) => b.bed_id === initialBed) ? initialBed! : "",
    doctor_id: "",
    reason: "",
    expected_discharge: "",
  });
  const [state, action, pending] = useActionState<WardState, FormData>(admitAction, { status: "idle" });
  const bind = (k: keyof typeof v) => ({ name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value })) });

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="patient_id" value={patientId} />
      {state.status === "error" && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Bed
          <select {...bind("bed_id")} required className={input}>
            <option value="" disabled>Choose a bed…</option>
            {beds.map((b) => (
              <option key={b.bed_id} value={b.bed_id}>{b.ward_name} · {b.label} · ₹{b.daily_rate.toLocaleString("en-IN")}/day</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Admitting doctor
          <select {...bind("doctor_id")} required className={input}>
            <option value="" disabled>Choose…</option>
            {doctors.map((d) => (
              <option key={d.doctor_id} value={d.doctor_id}>{d.full_name} · {d.department}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium sm:col-span-2">
          Reason for admission
          <input {...bind("reason")} maxLength={300} className={input} />
        </label>
        <label className="block text-sm font-medium">
          Expected discharge <span className="font-normal text-muted">(optional)</span>
          <input {...bind("expected_discharge")} type="date" className={input} />
        </label>
      </div>
      <button disabled={pending} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Admitting…" : "Admit patient"}
      </button>
    </form>
  );
}
