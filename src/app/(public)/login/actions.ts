"use server";

import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { safeNext } from "@/lib/session-cookie";
import { requestContext, setSessionCookie } from "@/server/auth/guard";
import { createSession, signIn } from "@/server/auth/users";
import { env } from "@/lib/env";
import { one } from "@/lib/db";

export type LoginState = { status: "idle" } | { status: "error"; message: string; email: string };

const MESSAGES = {
  invalid: "That email and password do not match an active account.",
  locked: "This account is temporarily locked after too many attempts. Try again in 15 minutes, or ask an administrator to reset your password.",
  throttled: "Too many failed attempts from this connection. Please wait a few minutes and try again.",
} as const;

/** Demo servers only (DEMO_QUICK_LOGIN=1): signs in as one of the *@democare.test role accounts, plus the one administrator named in DEMO_QUICK_ADMIN_EMAIL. */
export async function quickLogin(form: FormData): Promise<void> {
  if (env().DEMO_QUICK_LOGIN !== "1") redirect("/login");
  const email = String(form.get("email") ?? "").toLowerCase();
  const row = await one<{ user_id: string }>(
    pool(),
    `SELECT user_id FROM staff_users WHERE lower(email) = $1 AND ((email LIKE '%@democare.test' AND role <> 'admin') OR lower(email) = lower($2)) AND active`,
    [email, env().DEMO_QUICK_ADMIN_EMAIL ?? ""],
  );
  if (!row) redirect("/login");
  const s = await createSession(pool(), row.user_id, await requestContext());
  await setSessionCookie(s.token, s.expiresAt);
  redirect(safeNext(form.get("next")));
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").slice(0, 200);
  const password = String(form.get("password") ?? "").slice(0, 500);
  const next = safeNext(form.get("next"));

  if (!email || !password) return { status: "error", message: "Enter your email and password.", email };

  const result = await signIn(pool(), email, password, await requestContext());
  if (!result.ok) return { status: "error", message: MESSAGES[result.reason], email };

  await setSessionCookie(result.token, result.expiresAt);
  redirect(result.user.must_change_password ? "/account" : next);
}
