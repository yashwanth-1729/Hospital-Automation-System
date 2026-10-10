"use client";

import { useActionState, useState } from "react";
import { adjustStockAction, receiveStockAction, reorderLevelAction, type PharmacyState } from "../actions";

const IDLE: PharmacyState = { status: "idle" };
const input = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary aria-[invalid=true]:border-danger";

function Notice({ state }: { state: PharmacyState }) {
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}

const EMPTY = { batch_number: "", expiry_date: "", quantity: "", unit_cost: "", unit_price: "", supplier: "" };

export function ReceiveForm({ medicines, fixedMedicineId }: { medicines: { medicine_id: string; name: string }[]; fixedMedicineId?: string }) {
  const [values, setValues] = useState({ medicine_id: fixedMedicineId ?? "", ...EMPTY });
  const [state, action, pending] = useActionState(async (prev: PharmacyState, form: FormData) => {
    const result = await receiveStockAction(prev, form);
    // Keep everything on a rejection; clear the batch details (not the medicine) after a success.
    if (result.status === "ok") setValues((v) => ({ ...EMPTY, medicine_id: v.medicine_id }));
    return result;
  }, IDLE);
  const errors = state.status === "error" ? (state.errors ?? {}) : {};
  const bind = (name: keyof typeof values) => ({
    name,
    value: values[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [name]: e.target.value })),
    "aria-invalid": !!errors[name],
  });

  return (
    <form action={action} className="space-y-3 p-4">
      <Notice state={state} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fixedMedicineId ? (
          <input type="hidden" name="medicine_id" value={fixedMedicineId} />
        ) : (
          <label className="block text-xs font-medium sm:col-span-2">
            Medicine
            <select {...bind("medicine_id")} required className={input}>
              <option value="" disabled>Choose…</option>
              {medicines.map((m) => (
                <option key={m.medicine_id} value={m.medicine_id}>{m.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-xs font-medium">
          Batch number
          <input {...bind("batch_number")} required className={input} />
        </label>
        <label className="block text-xs font-medium">
          Expiry date
          <input {...bind("expiry_date")} type="date" required className={input} />
        </label>
        <label className="block text-xs font-medium">
          Quantity (units)
          <input {...bind("quantity")} inputMode="numeric" required className={input} />
        </label>
        <label className="block text-xs font-medium">
          Cost per unit ₹
          <input {...bind("unit_cost")} inputMode="decimal" className={input} />
        </label>
        <label className="block text-xs font-medium">
          Price per unit ₹
          <input {...bind("unit_price")} inputMode="decimal" required className={input} />
        </label>
        <label className="block text-xs font-medium">
          Supplier
          <input {...bind("supplier")} className={input} />
        </label>
      </div>
      <button disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Saving…" : "Receive stock"}
      </button>
    </form>
  );
}

export function AdjustForm({ batchId, onHand }: { batchId: string; onHand: number }) {
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState("");
  const [state, action, pending] = useActionState(async (prev: PharmacyState, form: FormData) => {
    const result = await adjustStockAction(prev, form);
    if (result.status === "ok") {
      setReason("");
      setDelta("");
    }
    return result;
  }, IDLE);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="batch_id" value={batchId} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs font-medium">
          Change by
          <input
            name="delta"
            inputMode="numeric"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            placeholder={`-${Math.min(onHand, 5)}`}
            className="mt-1 block w-24 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
        </label>
        <label className="min-w-40 flex-1 text-xs font-medium">
          Reason
          <input
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Damaged, expired, count correction…"
            className="mt-1 block w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
        </label>
        <button disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary disabled:opacity-60">
          Apply
        </button>
      </div>
      <Notice state={state} />
    </form>
  );
}

export function ReorderForm({ medicineId, level }: { medicineId: string; level: number }) {
  const [state, action, pending] = useActionState(reorderLevelAction, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="medicine_id" value={medicineId} />
      <label className="text-xs font-medium">
        Reorder when available falls to
        <input
          name="level"
          inputMode="numeric"
          defaultValue={level}
          className="mt-1 block w-28 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary"
        />
      </label>
      <button disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary disabled:opacity-60">
        Save
      </button>
      <Notice state={state} />
    </form>
  );
}
