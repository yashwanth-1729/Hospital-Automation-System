"use client";

import { useActionState } from "react";
import { changePasswordAction, type PasswordState } from "./actions";

const inputClass = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";

export function PasswordForm() {
  const [state, action, pending] = useActionState<PasswordState, FormData>(changePasswordAction, { status: "idle" });
  return (
    <form action={action} className="space-y-4">
      {state.status === "error" && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>
      )}
      {state.status === "done" && (
        <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
          Password changed. Any other devices have been signed out.
        </p>
      )}
      <label className="block text-sm font-medium">
        Current password
        <input name="current" type="password" required autoComplete="current-password" className={inputClass} />
      </label>
      <label className="block text-sm font-medium">
        New password
        <input name="next" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
        <span className="mt-1 block text-xs font-normal text-muted">At least 10 characters.</span>
      </label>
      <label className="block text-sm font-medium">
        Confirm new password
        <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
      </label>
      <button disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
