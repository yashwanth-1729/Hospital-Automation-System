"use client";

import { useActionState, useState } from "react";
import { reportAction, type ImagingState } from "../actions";

const field = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none";

export function ReportForm({ orderId }: { orderId: string }) {
  const [v, setV] = useState({ findings: "", impression: "" });
  const [state, action, pending] = useActionState<ImagingState, FormData>(reportAction, { status: "idle" });
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="order_id" value={orderId} />
      {state.status === "error" && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>}
      <label className="block text-sm font-medium">
        Findings
        <textarea name="findings" rows={5} value={v.findings} onChange={(e) => setV((s) => ({ ...s, findings: e.target.value }))} className={field} />
      </label>
      <label className="block text-sm font-medium">
        Impression <span className="font-normal text-muted">(what the study shows)</span>
        <textarea name="impression" rows={3} required value={v.impression} onChange={(e) => setV((s) => ({ ...s, impression: e.target.value }))} className={field} />
      </label>
      <button disabled={pending} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Saving…" : "Save report"}
      </button>
      <p className="text-xs text-muted">A report cannot be edited once saved. The doctor sees it straight away.</p>
    </form>
  );
}
