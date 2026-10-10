"use server";

import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { safeNext } from "@/lib/session-cookie";
import { requestContext, setSessionCookie } from "@/server/auth/guard";
import { signIn } from "@/server/auth/users";

export type LoginState = { status: "idle" } | { status: "error"; message: string; email: string };

const MESSAGES = {
  invalid: "That email and password do not match an active account.",
  locked: "This account is temporarily locked after too many attempts. Try again in 15 minutes, or ask an administrator to reset your password.",
  throttled: "Too many failed attempts from this connection. Please wait a few minutes and try again.",
} as const;

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
