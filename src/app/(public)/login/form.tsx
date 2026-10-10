"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const inputClass = "mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm outline-none";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { status: "idle" });
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="next" value={next} />
      {state.status === "error" && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.message}
        </p>
      )}
      <label className="block text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="username"
          defaultValue={state.status === "error" ? state.email : ""}
          className={inputClass}
        />
      </label>
      <label className="block text-sm font-medium">
        Password
        <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
      </label>
      <button disabled={pending} className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
