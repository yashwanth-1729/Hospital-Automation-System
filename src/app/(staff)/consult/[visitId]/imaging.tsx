"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui";
import { cancelOrderAction, orderStudyAction, type ImagingState } from "../../radiology/actions";

const IDLE: ImagingState = { status: "idle" };
const field = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none";

export interface ImagingRow {
  order_id: string;
  study: string;
  status: "ordered" | "in_progress" | "reported" | "cancelled";
  priority: "routine" | "urgent";
  impression: string | null;
  findings: string | null;
  reported_by_name: string | null;
}

const LABEL = { ordered: "Waiting for radiology", in_progress: "With radiology", reported: "Reported", cancelled: "Cancelled" } as const;
const TONE = { ordered: "warn", in_progress: "info", reported: "ok", cancelled: "neutral" } as const;

export function OrderForm({ visitId, studies }: { visitId: string; studies: { study: string }[] }) {
  const [v, setV] = useState({ study: "", indication: "", priority: "routine" });
  const [state, action, pending] = useActionState(async (prev: ImagingState, form: FormData) => {
    const r = await orderStudyAction(prev, form);
    if (r.status === "ok") setV({ study: "", indication: "", priority: "routine" });
    return r;
  }, IDLE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="visit_id" value={visitId} />
      {state.status === "error" && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>}
      {state.status === "ok" && <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>}
      <datalist id="studies">
        {studies.map((s) => (
          <option key={s.study} value={s.study} />
        ))}
      </datalist>
      <div className="grid gap-3 sm:grid-cols-12">
        <label className="block text-xs font-medium sm:col-span-5">
          Study
          <input name="study" list="studies" value={v.study} onChange={(e) => setV((s) => ({ ...s, study: e.target.value }))} autoComplete="off" className={field} />
        </label>
        <label className="block text-xs font-medium sm:col-span-5">
          Reason
          <input name="indication" value={v.indication} maxLength={300} onChange={(e) => setV((s) => ({ ...s, indication: e.target.value }))} className={field} />
        </label>
        <label className="flex items-end gap-2 pb-2 text-xs sm:col-span-2">
          <input type="checkbox" name="priority" value="urgent" checked={v.priority === "urgent"} onChange={(e) => setV((s) => ({ ...s, priority: e.target.checked ? "urgent" : "routine" }))} />
          Urgent
        </label>
      </div>
      <button disabled={pending || v.study.trim().length < 2} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
        {pending ? "Ordering…" : "Order study"}
      </button>
    </form>
  );
}

function CancelButton({ visitId, orderId }: { visitId: string; orderId: string }) {
  const [state, action, pending] = useActionState(cancelOrderAction, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="visit_id" value={visitId} />
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="reason" value="Not needed" />
      <button disabled={pending} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-danger hover:text-danger disabled:opacity-60">
        Cancel
      </button>
      {state.status === "error" && <p className="mt-1 text-xs text-danger">{state.message}</p>}
    </form>
  );
}

export function OrdersList({ visitId, orders, canCancel }: { visitId: string; orders: ImagingRow[]; canCancel: boolean }) {
  if (orders.length === 0) return <p className="text-sm text-muted">No imaging ordered for this visit.</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {orders.map((o) => (
        <li key={o.order_id} className="space-y-1 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {o.study}
              {o.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
              <Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge>
            </span>
            {canCancel && o.status === "ordered" && <CancelButton visitId={visitId} orderId={o.order_id} />}
          </div>
          {o.status === "reported" && (
            <div className="rounded-lg bg-surface-2 px-3 py-2">
              {o.findings && <p className="whitespace-pre-wrap text-muted">{o.findings}</p>}
              <p className="font-medium whitespace-pre-wrap">Impression: {o.impression}</p>
              <p className="text-xs text-muted">Reported by {o.reported_by_name}</p>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
