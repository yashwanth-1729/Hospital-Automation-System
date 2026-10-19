"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { one } from "@/lib/db";
import { requestContext, setSessionCookie } from "@/server/auth/guard";
import { pool } from "@/lib/db";
import { isRole } from "@/lib/rbac";
import { requireStaff } from "@/server/auth/guard";
import { generatePassword } from "@/server/auth/password";
import { AuthError, createSession, createStaffUser, resetPassword, setUserActive, setUserRole } from "@/server/auth/users";

export type UserActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  // The one-time password is returned to the administrator once and never stored in the clear.
  | { status: "created"; email: string; password: string }
  | { status: "reset"; email: string; password: string }
  | { status: "ok"; message: string };

async function guarded<T>(fn: () => Promise<T>): Promise<T | { status: "error"; message: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError) return { status: "error", message: err.message };
    throw err;
  }
}

/** Administrator opens an account as that person. Recorded against the administrator; replaces their own session. */
export async function signInAsAction(form: FormData): Promise<void> {
  const me = await requireStaff("users.manage");
  const userId = String(form.get("user_id") ?? "");
  const target = await one<{ user_id: string }>(pool(), `SELECT user_id FROM staff_users WHERE user_id = $1 AND active AND user_id <> $2`, [userId, me.user_id]);
  if (!target) redirect("/admin/users");
  const s = await createSession(pool(), target.user_id, await requestContext());
  await audit(pool(), { workflow: "access", actor: "staff", action: "admin_signed_in_as", recordId: target.user_id, details: { by: me.user_id }, actorId: me.user_id });
  await setSessionCookie(s.token, s.expiresAt);
  redirect("/");
}

export async function createUserAction(_prev: UserActionState, form: FormData): Promise<UserActionState> {
  await requireStaff("users.manage");
  const role = String(form.get("role") ?? "");
  if (!isRole(role)) return { status: "error", message: "Choose a role." };

  const email = String(form.get("email") ?? "");
  const password = generatePassword();
  const result = await guarded(async () => {
    const user = await createStaffUser(pool(), {
      email,
      fullName: String(form.get("full_name") ?? ""),
      role,
      doctorId: String(form.get("doctor_id") ?? "") || null,
      password,
      mustChangePassword: true,
    });
    return { status: "created" as const, email: user.email, password };
  });
  revalidatePath("/admin/users");
  return result;
}

export async function resetPasswordAction(_prev: UserActionState, form: FormData): Promise<UserActionState> {
  const me = await requireStaff("users.manage");
  const userId = String(form.get("user_id") ?? "");
  const email = String(form.get("email") ?? "");
  if (userId === me.user_id) return { status: "error", message: "Use My account to change your own password." };
  const result = await guarded(async () => ({ status: "reset" as const, email, password: await resetPassword(pool(), userId) }));
  revalidatePath("/admin/users");
  return result;
}

export async function setActiveAction(_prev: UserActionState, form: FormData): Promise<UserActionState> {
  const me = await requireStaff("users.manage");
  const userId = String(form.get("user_id") ?? "");
  const active = String(form.get("active") ?? "") === "true";
  if (userId === me.user_id && !active) return { status: "error", message: "You cannot deactivate your own account." };
  const result = await guarded(async () => {
    await setUserActive(userId, active);
    return { status: "ok" as const, message: active ? "Account reactivated." : "Account deactivated and signed out." };
  });
  revalidatePath("/admin/users");
  return result;
}

export async function setRoleAction(_prev: UserActionState, form: FormData): Promise<UserActionState> {
  const me = await requireStaff("users.manage");
  const userId = String(form.get("user_id") ?? "");
  const role = String(form.get("role") ?? "");
  if (!isRole(role)) return { status: "error", message: "Choose a role." };
  if (userId === me.user_id && role !== "admin") return { status: "error", message: "You cannot change your own role." };
  const result = await guarded(async () => {
    await setUserRole(userId, role, String(form.get("doctor_id") ?? "") || null);
    return { status: "ok" as const, message: "Role updated. They will need to sign in again." };
  });
  revalidatePath("/admin/users");
  return result;
}
