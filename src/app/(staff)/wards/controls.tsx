"use client";

import { useActionState, useState } from "react";
import { addWardAction, bedReadyAction, maintenanceAction, type WardState } from "./actions";

const IDLE: WardState = { status: "idle" };
const input = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

function Notice({ state }: { state: WardState }) {
  if (state.status === "error") return <p role="alert" className="mt-1 text-xs text-danger">{state.message}</p>;
  return null;
}

export function BedButton({ bedId, kind }: { bedId: string; kind: "ready" | "maintenance_on" | "maintenance_off" }) {
  const [state, action, pending] = useActionState(kind === "ready" ? bedReadyAction : maintenanceAction, IDLE);
  const label = kind === "ready" ? "Mark ready" : kind === "maintenance_on" ? "Maintenance" : "Back in service";
  return (
    <form action={action}>
      <input type="hidden" name="bed_id" value={bedId} />
      {kind !== "ready" && <input type="hidden" name="on" value={kind === "maintenance_on" ? "true" : "false"} />}
      <button disabled={pending} className="rounded-md border border-border px-2 py-0.5 text-xs transition-colors hover:border-primary hover:text-primary disabled:opacity-60">
        {pending ? "…" : label}
      </button>
      <Notice state={state} />
    </form>
  );
}

export function AddWardForm() {
  const empty = { name: "", kind: "general", daily_rate: "", beds: "" };
  const [v, setV] = useState(empty);
  const [state, action, pending] = useActionState(async (prev: WardState, form: FormData) => {
    const r = await addWardAction(prev, form);
    if (r.status === "ok") setV(empty);
    return r;
  }, IDLE);
  const bind = (k: keyof typeof v) => ({ name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value })) });
  return (
    <form action={action} className="space-y-3 p-4">
      {state.status === "ok" && <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>}
      {state.status === "error" && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-xs font-medium sm:col-span-2">
          Ward name
          <input {...bind("name")} required className={input} />
        </label>
        <label className="block text-xs font-medium">
          Type
          <select {...bind("kind")} className={input}>
            <option value="general">General</option>
            <option value="semi_private">Semi-private</option>
            <option value="private">Private</option>
            <option value="icu">Intensive care</option>
            <option value="day_care">Day care</option>
          </select>
        </label>
        <label className="block text-xs font-medium">
          Rate per day ₹
          <input {...bind("daily_rate")} inputMode="decimal" required className={input} />
        </label>
        <label className="block text-xs font-medium">
          Number of beds
          <input {...bind("beds")} inputMode="numeric" required className={input} />
        </label>
      </div>
      <button disabled={pending} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
        {pending ? "Adding…" : "Add ward"}
      </button>
    </form>
  );
}
