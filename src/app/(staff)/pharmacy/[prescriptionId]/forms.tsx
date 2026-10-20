"use client";

import { useActionState, useState } from "react";
import { closeAction, dispenseAction, linkItemAction, substituteAction, type PharmacyState } from "../actions";

const IDLE: PharmacyState = { status: "idle" };
const input = "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-primary";

function Notice({ state }: { state: PharmacyState }) {
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}

export interface DispenseItem {
  item_id: string;
  name: string;
  sig: string;
  instructions: string | null;
  outstanding: number;
  given: number;
  prescribed: number;
  available: number;
  unit_price: number | null;
  next_expiry: string | null;
  linked: boolean;
  allergen: string | null;
  alternatives: { medicine_id: string; name: string; available: number; unit_price: number | null }[];
}

function Alternatives({ prescriptionId, item }: { prescriptionId: string; item: DispenseItem }) {
  const [state, action, pending] = useActionState(substituteAction, IDLE);
  return (
    <div className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-xs">
      <p className="font-medium text-warn">Not enough in stock. Same medicine, other brands:</p>
      {item.alternatives.length === 0 ? (
        <p className="mt-1 text-muted">No other brand in stock. Give what is available, or close the prescription below.</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {item.alternatives.map((a) => (
            <form key={a.medicine_id} action={action}>
              <input type="hidden" name="prescription_id" value={prescriptionId} />
              <input type="hidden" name="item_id" value={item.item_id} />
              <input type="hidden" name="medicine_id" value={a.medicine_id} />
              <button disabled={pending} className="rounded-full border border-primary bg-surface px-3 py-1 text-primary hover:bg-primary-soft disabled:opacity-60">
                Use {a.name} ({a.available} in stock{a.unit_price !== null ? `, ₹${a.unit_price}` : ""})
              </button>
            </form>
          ))}
        </div>
      )}
      {state.status === "error" && <p className="mt-1 text-danger">{state.message}</p>}
    </div>
  );
}

export function DispenseForm({ prescriptionId, items }: { prescriptionId: string; items: DispenseItem[] }) {
  const [state, action, pending] = useActionState(dispenseAction, IDLE);
  // Offer what can actually be filled, so the common case is one click.
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.item_id, i.linked && i.outstanding > 0 ? String(Math.min(i.outstanding, i.available)) : "0"])),
  );

  const total = items.reduce((sum, i) => sum + (Number(qty[i.item_id]) || 0) * (i.unit_price ?? 0), 0);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="prescription_id" value={prescriptionId} />
      <Notice state={state} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs tracking-wide text-muted uppercase">
            <tr>
              <th className="py-2 pr-3 font-medium">Medicine</th>
              <th className="px-3 py-2 font-medium">Prescribed</th>
              <th className="px-3 py-2 font-medium">In stock</th>
              <th className="px-3 py-2 font-medium">Give now</th>
              <th className="py-2 pl-3 text-right font-medium">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((i) => {
              const done = i.outstanding === 0;
              const short = i.linked && !done && i.available < i.outstanding;
              return (
                <tr key={i.item_id} className={done ? "opacity-60" : ""}>
                  <td className="py-3 pr-3 align-top">
                    <div className="font-medium">{i.name}</div>
                    <div className="text-xs text-muted">{i.sig}</div>
                    {i.instructions && <div className="text-xs text-muted">{i.instructions}</div>}
                    {i.allergen && <div className="mt-1 text-xs font-medium text-danger">Matches recorded allergy: {i.allergen}</div>}
                    {!i.linked && !done && <div className="mt-1 text-xs text-warn">Not in the formulary: match it below.</div>}
                    {short && i.given === 0 && <Alternatives prescriptionId={prescriptionId} item={i} />}
                  </td>
                  <td className="num px-3 py-3 align-top">
                    {i.prescribed}
                    {i.given > 0 && <div className="text-xs text-muted">{i.given} given</div>}
                  </td>
                  <td className="num px-3 py-3 align-top">
                    {i.linked ? i.available : "—"}
                    {short && <div className="text-xs text-warn">Short by {i.outstanding - i.available}</div>}
                    {i.next_expiry && <div className="text-xs text-muted">exp {i.next_expiry.split(", ").slice(1).join(", ")}</div>}
                  </td>
                  <td className="px-3 py-3 align-top">
                    {done ? (
                      <span className="text-xs text-ok">Complete</span>
                    ) : (
                      <input
                        name={`qty.${i.item_id}`}
                        inputMode="numeric"
                        value={qty[i.item_id] ?? "0"}
                        onChange={(e) => setQty((q) => ({ ...q, [i.item_id]: e.target.value }))}
                        disabled={!i.linked}
                        aria-label={`Quantity of ${i.name} to give`}
                        className={`${input} num w-20`}
                      />
                    )}
                  </td>
                  <td className="num py-3 pl-3 text-right align-top">
                    {i.unit_price !== null && !done ? `₹${((Number(qty[i.item_id]) || 0) * i.unit_price).toFixed(2)}` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="num text-sm">
          Total <span className="text-lg font-semibold">₹{total.toFixed(2)}</span>
        </div>
        <button disabled={pending} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
          {pending ? "Dispensing…" : "Dispense and send to billing"}
        </button>
      </div>
    </form>
  );
}

export function LinkItemForm({
  prescriptionId,
  itemId,
  label,
  options,
}: {
  prescriptionId: string;
  itemId: string;
  label: string;
  options: { medicine_id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(linkItemAction, IDLE);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="prescription_id" value={prescriptionId} />
      <input type="hidden" name="item_id" value={itemId} />
      <label className="text-xs font-medium">
        “{label}” is
        <select name="medicine_id" required defaultValue="" className={`${input} mt-1 block w-72`}>
          <option value="" disabled>Choose a product…</option>
          {options.map((o) => (
            <option key={o.medicine_id} value={o.medicine_id}>{o.name}</option>
          ))}
        </select>
      </label>
      <button disabled={pending} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
        Match
      </button>
      <Notice state={state} />
    </form>
  );
}

export function CloseForm({ prescriptionId }: { prescriptionId: string }) {
  const [note, setNote] = useState("");
  const [state, action, pending] = useActionState(closeAction, IDLE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="prescription_id" value={prescriptionId} />
      <Notice state={state} />
      <label className="block text-sm font-medium">
        Close this prescription, with a reason
        <input
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: out of stock, patient will buy the rest outside"
          maxLength={300}
          className={`${input} mt-1 w-full`}
        />
      </label>
      <button disabled={pending || note.trim().length < 3} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-60">
        Close prescription
      </button>
    </form>
  );
}
