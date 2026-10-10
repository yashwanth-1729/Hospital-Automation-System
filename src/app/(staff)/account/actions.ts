"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { clearSessionCookie, requireStaff, sessionToken } from "@/server/auth/guard";
import { AuthError, changePassword, endSession } from "@/server/auth/users";

export type PasswordState = { status: "idle" } | { status: "error"; message: string } | { status: "done" };

export async function logoutAction() {
  await endSession(pool(), await sessionToken());
  await clearSessionCookie();
  redirect("/login");
}

export async function changePasswordAction(_prev: PasswordState, form: FormData): Promise<PasswordState> {
  const user = await requireStaff(undefined, { allowPasswordChange: true });
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (next !== confirm) return { status: "error", message: "The two new passwords do not match." };

  try {
    await changePassword(pool(), { userId: user.user_id, current, next, keepSessionToken: await sessionToken() });
  } catch (err) {
    if (err instanceof AuthError) return { status: "error", message: err.message };
    throw err;
  }
  // The layout was rendered for someone who must change their password (no menu). Drop it so
  // the next page is built with the full menu rather than the cached one.
  revalidatePath("/", "layout");
  // A forced change lands them on the home page; a voluntary one confirms in place.
  if (user.must_change_password) redirect("/");
  return { status: "done" };
}
