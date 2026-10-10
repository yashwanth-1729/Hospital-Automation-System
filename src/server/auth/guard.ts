import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { enterActor } from "@/lib/actor";
import { pool } from "@/lib/db";
import { env } from "@/lib/env";
import { can, type Capability } from "@/lib/rbac";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { userForSession, type SignInContext, type StaffUser } from "./users";

/**
 * The signed-in person for this request, or null. Cached so a layout, a page and an action
 * asking in the same request cost one query.
 */
export const currentStaff = cache(async (): Promise<StaffUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return userForSession(pool(), token);
});

/**
 * Call at the top of every staff page and action. Authorisation is decided here, against the
 * database, on every call: the proxy only checks that a cookie exists and is not a security
 * boundary.
 */
export async function requireStaff(capability?: Capability, opts: { allowPasswordChange?: boolean } = {}): Promise<StaffUser> {
  const user = await currentStaff();
  if (!user) redirect("/login");
  if (user.must_change_password && !opts.allowPasswordChange) redirect("/account");
  if (capability && !can(user.role, capability)) redirect("/no-access");
  // From here on, audit rows written while handling this request name this person.
  enterActor(user.user_id);
  return user;
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().PUBLIC_BASE_URL.startsWith("https://"),
    path: "/",
    expires,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function requestContext(): Promise<SignInContext> {
  const h = await headers();
  return {
    // Caddy overwrites X-Forwarded-For with the real client address, so the first entry is it.
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local",
    userAgent: h.get("user-agent"),
  };
}
