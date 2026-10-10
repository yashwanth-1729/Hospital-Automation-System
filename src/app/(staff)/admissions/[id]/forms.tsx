"use client";

import { useActionState, useState } from "react";
import { dischargeAction, transferAction, type WardState } from "../../wards/actions";

const IDLE: WardState = { status: "idle" };
const input = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

function Notice({ state }: { state: WardState }) {
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}

export function TransferForm({ admissionId, beds }: { admissionId: string; beds: { bed_id: string; label: string; ward_name: string; daily_rate: number }[] }) {
  const [bed, setBed] = useState("");
  const [state, action, pending] = useActionState(async (prev: WardState, form: FormData) => {
    const r = await transferAction(prev, form);
    if (r.status === "ok") setBed("");
    return r;
  }, IDLE);
  if (beds.length === 0) return <p className="text-sm text-muted">No free beds to move to.</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="admission_id" value={admissionId} />
      <Notice state={state} />
      <label className="block text-sm font-medium">
        New bed
        <select name="bed_id" value={bed} onChange={(e) => setBed(e.target.value)} required className={input}>
          <option value="" disabled>Choose a bed…</option>
          {beds.map((b) => (
            <option key={b.bed_id} value={b.bed_id}>{b.ward_name} · {b.label} · ₹{b.daily_rate.toLocaleString("en-IN")}/day</option>
          ))}
        </select>
      </label>
      <button disabled={pending || !bed} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
        {pending ? "Moving…" : "Move patient"}
      </button>
    </form>
  );
}

export function DischargeForm({
  admissionId,
  doctors,
  defaultApprover,
}: {
  admissionId: string;
  doctors: { doctor_id: string; full_name: string }[];
  defaultApprover: string;
}) {
  const [v, setV] = useState({ follow_up_date: "", approved_by: defaultApprover });
  const [state, action, pending] = useActionState(dischargeAction, IDLE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="admission_id" value={admissionId} />
      <Notice state={state} />
      <label className="block text-sm font-medium">
        Follow-up visit <span className="font-normal text-muted">(optional)</span>
        <input type="date" name="follow_up_date" value={v.follow_up_date} onChange={(e) => setV((s) => ({ ...s, follow_up_date: e.target.value }))} className={input} />
      </label>
      {v.follow_up_date && (
        <label className="block text-sm font-medium">
          Date approved by
          <select name="approved_by" value={v.approved_by} onChange={(e) => setV((s) => ({ ...s, approved_by: e.target.value }))} className={input}>
            {doctors.map((d) => (
              <option key={d.doctor_id} value={d.full_name}>{d.full_name}</option>
            ))}
          </select>
        </label>
      )}
      <button disabled={pending} className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Discharging…" : "Discharge patient"}
      </button>
      <p className="text-xs text-muted">The bed goes for cleaning, and the patient gets a follow-up reminder and a feedback request on WhatsApp.</p>
    </form>
  );
}
