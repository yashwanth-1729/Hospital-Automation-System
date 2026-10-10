"use client";

import { useActionState } from "react";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/rbac";
import {
  createUserAction,
  resetPasswordAction,
  setActiveAction,
  setRoleAction,
  type UserActionState,
} from "./actions";

const inputClass = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary";
const IDLE: UserActionState = { status: "idle" };

function Notice({ state }: { state: UserActionState }) {
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.message}</p>;
  if (state.status === "ok") return <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  if (state.status === "created" || state.status === "reset") {
    return (
      <div role="status" className="rounded-lg border border-ok/30 bg-ok-soft px-3 py-2 text-sm">
        <div className="font-medium text-ok">{state.status === "created" ? "Account created." : "Password reset."} Give this to {state.email} now:</div>
        <div className="mt-1 font-mono text-base select-all">{state.password}</div>
        <div className="mt-1 text-xs text-muted">It is shown only once. They will be asked to choose their own on first sign-in.</div>
      </div>
    );
  }
  return null;
}

export function CreateUserForm({ doctors }: { doctors: { doctor_id: string; full_name: string; department: string; taken: boolean }[] }) {
  const [state, action, pending] = useActionState(createUserAction, IDLE);
  return (
    <form action={action} className="space-y-3 p-4">
      <Notice state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Full name
          <input name="full_name" required className={inputClass} />
        </label>
        <label className="block text-sm font-medium">
          Email
          <input name="email" type="email" required className={inputClass} />
        </label>
        <label className="block text-sm font-medium">
          Role
          <select name="role" defaultValue="receptionist" className={inputClass}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Doctor record <span className="font-normal text-muted">(doctors only)</span>
          <select name="doctor_id" defaultValue="" className={inputClass}>
            <option value="">—</option>
            {doctors.filter((d) => !d.taken).map((d) => (
              <option key={d.doctor_id} value={d.doctor_id}>{d.full_name} · {d.department}</option>
            ))}
          </select>
        </label>
      </div>
      <button disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}

export function UserRowActions(props: {
  userId: string;
  email: string;
  role: Role;
  active: boolean;
  isSelf: boolean;
}) {
  const [resetState, resetAction, resetting] = useActionState(resetPasswordAction, IDLE);
  const [activeState, activeAction, toggling] = useActionState(setActiveAction, IDLE);
  const [roleState, roleAction, changing] = useActionState(setRoleAction, IDLE);
  const state = [resetState, activeState, roleState].find((s) => s.status !== "idle") ?? IDLE;

  if (props.isSelf) return <span className="text-xs text-muted">This is you</span>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <form action={roleAction} className="flex gap-1">
          <input type="hidden" name="user_id" value={props.userId} />
          <select name="role" defaultValue={props.role} aria-label="Role" className="rounded-lg border border-border bg-surface px-2 py-1 text-xs">
            {ROLES.filter((r) => r !== "doctor" || props.role === "doctor").map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <button disabled={changing} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-primary hover:text-primary">Set</button>
        </form>
        <form action={resetAction}>
          <input type="hidden" name="user_id" value={props.userId} />
          <input type="hidden" name="email" value={props.email} />
          <button disabled={resetting} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-primary hover:text-primary">
            Reset password
          </button>
        </form>
        <form action={activeAction}>
          <input type="hidden" name="user_id" value={props.userId} />
          <input type="hidden" name="active" value={props.active ? "false" : "true"} />
          <button disabled={toggling} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-danger hover:text-danger">
            {props.active ? "Deactivate" : "Reactivate"}
          </button>
        </form>
      </div>
      <Notice state={state} />
    </div>
  );
}
