"use client";

import { useActionState, useEffect, useState } from "react";
import { METHODS, METHOD_LABEL } from "@/lib/payment-methods";
import { addLineAction, discountAction, issueAction, payAction, refundAction, removeLineAction, voidAction, type BillingState } from "../actions";

const IDLE: BillingState = { status: "idle" };
const input = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary aria-[invalid=true]:border-danger";

function Notice({ state }: { state: BillingState }) {
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}

/** Wraps an action so a successful result clears the fields, and a rejection keeps them. */
function useFormAction(action: (prev: BillingState, form: FormData) => Promise<BillingState>, onOk: () => void) {
  return useActionState(async (prev: BillingState, form: FormData) => {
    const result = await action(prev, form);
    if (result.status === "ok") onOk();
    return result;
  }, IDLE);
}

export function AddLineForm({ invoiceId, services }: { invoiceId: string; services: { name: string; default_price: number; tax_rate: number }[] }) {
  const empty = { description: "", quantity: "1", unit_price: "", tax_rate: "0" };
  const [v, setV] = useState(empty);
  const [state, action, pending] = useFormAction(addLineAction, () => setV(empty));
  const errors = state.status === "error" ? (state.errors ?? {}) : {};
  const bind = (k: keyof typeof v) => ({ name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value })), "aria-invalid": !!errors[k] });

  const pick = (name: string) => {
    const s = services.find((x) => x.name === name);
    if (s) setV((cur) => ({ ...cur, description: s.name, unit_price: String(s.default_price), tax_rate: String(s.tax_rate) }));
  };

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <Notice state={state} />
      {services.length > 0 && (
        <label className="block text-xs font-medium">
          From the service list
          <select defaultValue="" onChange={(e) => pick(e.target.value)} className={input}>
            <option value="">Choose a service, or type your own below</option>
            {services.map((s) => (
              <option key={s.name} value={s.name}>{s.name} · ₹{s.default_price}</option>
            ))}
          </select>
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-12">
        <label className="block text-xs font-medium sm:col-span-6">
          Description
          <input {...bind("description")} maxLength={160} className={input} />
        </label>
        <label className="block text-xs font-medium sm:col-span-2">
          Qty
          <input {...bind("quantity")} inputMode="decimal" className={input} />
        </label>
        <label className="block text-xs font-medium sm:col-span-2">
          Rate ₹
          <input {...bind("unit_price")} inputMode="decimal" className={input} />
        </label>
        <label className="block text-xs font-medium sm:col-span-2">
          GST %
          <input {...bind("tax_rate")} inputMode="decimal" className={input} />
        </label>
      </div>
      <button disabled={pending} className="rounded-lg border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft disabled:opacity-60">
        {pending ? "Adding…" : "Add charge"}
      </button>
    </form>
  );
}

export function RemoveLineButton({ invoiceId, lineId }: { invoiceId: string; lineId: string }) {
  const [state, action, pending] = useActionState(removeLineAction, IDLE);
  return (
    <form action={action}>
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="line_id" value={lineId} />
      <button disabled={pending} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-danger hover:text-danger disabled:opacity-60">
        Remove
      </button>
      {state.status === "error" && <p className="mt-1 text-xs text-danger">{state.message}</p>}
    </form>
  );
}

export function DiscountForm({ invoiceId, limit, isAdmin }: { invoiceId: string; limit: number; isAdmin: boolean }) {
  const [v, setV] = useState({ mode: "percent", value: "", reason: "" });
  const [state, action, pending] = useFormAction(discountAction, () => undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <Notice state={state} />
      <div className="grid gap-3 sm:grid-cols-12">
        <label className="block text-xs font-medium sm:col-span-3">
          Type
          <select name="mode" value={v.mode} onChange={(e) => setV((s) => ({ ...s, mode: e.target.value }))} className={input}>
            <option value="percent">Percent</option>
            <option value="amount">Amount ₹</option>
          </select>
        </label>
        <label className="block text-xs font-medium sm:col-span-3">
          Value
          <input name="value" inputMode="decimal" value={v.value} onChange={(e) => setV((s) => ({ ...s, value: e.target.value }))} className={input} />
        </label>
        <label className="block text-xs font-medium sm:col-span-6">
          Reason
          <input name="reason" value={v.reason} onChange={(e) => setV((s) => ({ ...s, reason: e.target.value }))} className={input} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary disabled:opacity-60">
          Apply discount
        </button>
        <span className="text-xs text-muted">{isAdmin ? "As an administrator you may exceed the usual limit." : `Above ${limit}% needs an administrator.`}</span>
      </div>
    </form>
  );
}

export function IssueForm({ invoiceId, disabled }: { invoiceId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(issueAction, IDLE);
  return (
    <form action={action} className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <Notice state={state} />
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={pending || disabled}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Issuing…" : "Issue invoice"}
        </button>
        <span className="text-xs text-muted">Issuing numbers the invoice and locks its charges.</span>
      </div>
    </form>
  );
}

export function PayForm({ invoiceId, balance, idempotencyKey }: { invoiceId: string; balance: number; idempotencyKey: string }) {
  const [v, setV] = useState({ amount: balance.toFixed(2), method: "cash", reference: "" });
  const [state, action, pending] = useFormAction(payAction, () => setV((s) => ({ ...s, reference: "" })));
  // After a part payment the next amount offered is what is still owed.
  useEffect(() => setV((s) => ({ ...s, amount: balance.toFixed(2) })), [balance]);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <Notice state={state} />
      <label className="block text-xs font-medium">
        Amount received ₹
        <input name="amount" inputMode="decimal" value={v.amount} onChange={(e) => setV((s) => ({ ...s, amount: e.target.value }))} className={`${input} num text-lg font-semibold`} />
      </label>
      <label className="block text-xs font-medium">
        Paid by
        <select name="method" value={v.method} onChange={(e) => setV((s) => ({ ...s, method: e.target.value }))} className={input}>
          {METHODS.map((m) => (
            <option key={m} value={m}>{METHOD_LABEL[m]}</option>
          ))}
        </select>
      </label>
      {v.method !== "cash" && (
        <label className="block text-xs font-medium">
          Reference <span className="font-normal text-muted">(UTR, card slip, claim no.)</span>
          <input name="reference" value={v.reference} maxLength={80} onChange={(e) => setV((s) => ({ ...s, reference: e.target.value }))} className={input} />
        </label>
      )}
      <button disabled={pending} className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Recording…" : "Record payment"}
      </button>
    </form>
  );
}

export function RefundForm({ invoiceId, max }: { invoiceId: string; max: number }) {
  const [v, setV] = useState({ amount: "", method: "cash", reason: "" });
  const [state, action, pending] = useFormAction(refundAction, () => setV({ amount: "", method: "cash", reason: "" }));
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <Notice state={state} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium">
          Amount ₹ <span className="font-normal text-muted">(up to {max.toFixed(2)})</span>
          <input name="amount" inputMode="decimal" value={v.amount} onChange={(e) => setV((s) => ({ ...s, amount: e.target.value }))} className={input} />
        </label>
        <label className="block text-xs font-medium">
          Returned by
          <select name="method" value={v.method} onChange={(e) => setV((s) => ({ ...s, method: e.target.value }))} className={input}>
            {METHODS.map((m) => (
              <option key={m} value={m}>{METHOD_LABEL[m]}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium">
        Reason
        <input name="reason" value={v.reason} onChange={(e) => setV((s) => ({ ...s, reason: e.target.value }))} className={input} />
      </label>
      <button disabled={pending} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-60">
        Record refund
      </button>
    </form>
  );
}

export function VoidForm({ invoiceId, hasPayments }: { invoiceId: string; hasPayments: boolean }) {
  const [reason, setReason] = useState("");
  const [state, action, pending] = useFormAction(voidAction, () => setReason(""));
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <Notice state={state} />
      {hasPayments && <p className="text-xs text-muted">Payments have been received. Refund them first; then the invoice can be voided.</p>}
      <label className="block text-xs font-medium">
        Reason
        <input name="reason" value={reason} onChange={(e) => setReason(e.target.value)} className={input} />
      </label>
      <button
        disabled={pending || reason.trim().length < 3}
        className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger disabled:opacity-60"
      >
        Void invoice
      </button>
    </form>
  );
}
