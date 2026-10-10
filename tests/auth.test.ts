import { beforeEach, describe, expect, it } from "vitest";
import { many, one, pool } from "@/lib/db";
import { runAs } from "@/lib/actor";
import { audit } from "@/lib/audit";
import { can, CAPABILITIES, ROLES } from "@/lib/rbac";
import { safeNext } from "@/lib/session-cookie";
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from "@/server/auth/password";
import {
  AuthError,
  changePassword,
  createStaffUser,
  endSession,
  IP_FAILURE_LIMIT,
  MAX_FAILED_ATTEMPTS,
  resetPassword,
  setUserActive,
  setUserRole,
  signIn,
  userForSession,
} from "@/server/auth/users";
import { resetData } from "./helpers";

const PASSWORD = "correct horse battery";

async function admin(email = "asha@hospital.com") {
  return createStaffUser(pool(), { email, fullName: "Asha Rao", role: "admin", password: PASSWORD });
}

beforeEach(async () => {
  await resetData();
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("something else entirely", hash)).toBe(false);
  });

  it("salts every hash, so equal passwords do not look equal", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("never stores the password itself", async () => {
    expect(await hashPassword(PASSWORD)).not.toContain(PASSWORD);
  });

  it("rejects malformed stored values instead of throwing", async () => {
    for (const bad of ["", "plain", "scrypt$1$2$3", "bcrypt$a$b$c$d$e", "scrypt$x$8$1$salt$hash"]) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it("flags passwords that are too short, repeated or obvious", () => {
    expect(passwordProblem("short")).toMatch(/at least/);
    expect(passwordProblem("aaaaaaaaaaaa")).toBeTruthy();
    expect(passwordProblem("MyPassword2024")).toBeTruthy();
    expect(passwordProblem("asha@hospital.com", { email: "asha@hospital.com" })).toBeTruthy();
    expect(passwordProblem(PASSWORD)).toBeNull();
  });

  it("generates one-time passwords that pass the policy and differ each time", () => {
    const a = generatePassword();
    expect(passwordProblem(a)).toBeNull();
    expect(generatePassword()).not.toBe(a);
  });
});

describe("roles and capabilities", () => {
  it("lets administrators do everything", () => {
    for (const c of CAPABILITIES) expect(can("admin", c)).toBe(true);
  });

  it("keeps account management and reports away from everyone else", () => {
    for (const role of ROLES.filter((r) => r !== "admin")) {
      expect(can(role, "users.manage"), role).toBe(false);
      expect(can(role, "reports.view"), role).toBe(false);
      expect(can(role, "audits.manage"), role).toBe(false);
    }
  });

  it("keeps lead handling to the front desk", () => {
    expect(can("receptionist", "leads.manage")).toBe(true);
    for (const role of ["doctor", "nurse", "pharmacist", "billing"] as const) expect(can(role, "leads.manage")).toBe(false);
  });
});

describe("redirect targets", () => {
  it("accepts same-site paths only", () => {
    expect(safeNext("/appointments")).toBe("/appointments");
    expect(safeNext("/leads?status=new")).toBe("/leads?status=new");
    for (const hostile of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", null, undefined, 42]) {
      expect(safeNext(hostile), String(hostile)).toBe("/");
    }
    expect(safeNext("/login")).toBe("/");
  });
});

describe("creating accounts", () => {
  it("stores the email lower-cased and never the password", async () => {
    const u = await createStaffUser(pool(), { email: "  Asha@Hospital.COM ", fullName: "Asha Rao", role: "admin", password: PASSWORD });
    expect(u.email).toBe("asha@hospital.com");
    const row = await one<{ password_hash: string }>(pool(), `SELECT password_hash FROM staff_users WHERE user_id = $1`, [u.user_id]);
    expect(row!.password_hash).not.toContain(PASSWORD);
  });

  it("refuses a second account on the same email, whatever the case", async () => {
    await admin("asha@hospital.com");
    await expect(admin("ASHA@hospital.com")).rejects.toMatchObject({ code: "email_taken" });
  });

  it("refuses weak passwords and bad emails with a reason", async () => {
    await expect(createStaffUser(pool(), { email: "a@b.co", fullName: "Asha Rao", role: "admin", password: "short" })).rejects.toMatchObject({
      code: "weak_password",
    });
    await expect(createStaffUser(pool(), { email: "nope", fullName: "Asha Rao", role: "admin", password: PASSWORD })).rejects.toMatchObject({
      code: "invalid_email",
    });
  });

  it("binds a doctor account to exactly one doctor record", async () => {
    await expect(
      createStaffUser(pool(), { email: "d@h.com", fullName: "Dr Test", role: "doctor", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "doctor_required" });

    const doctor = (await many<{ doctor_id: string }>(pool(), `SELECT doctor_id FROM doctors LIMIT 1`))[0]!.doctor_id;
    const u = await createStaffUser(pool(), { email: "d@h.com", fullName: "Dr Test", role: "doctor", doctorId: doctor, password: PASSWORD });
    expect(u.doctor_id).toBe(doctor);

    await expect(
      createStaffUser(pool(), { email: "d2@h.com", fullName: "Dr Other", role: "doctor", doctorId: doctor, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "doctor_taken" });
  });
});

describe("signing in", () => {
  it("opens a session that resolves back to the person", async () => {
    const u = await admin();
    const r = await signIn(pool(), "ASHA@hospital.com", PASSWORD, { ip: "10.0.0.1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.user_id).toBe(u.user_id);
    expect((await userForSession(pool(), r.token))?.user_id).toBe(u.user_id);
  });

  it("stores only a hash of the session token", async () => {
    await admin();
    const r = await signIn(pool(), "asha@hospital.com", PASSWORD);
    if (!r.ok) throw new Error("sign-in failed");
    const stored = await many<{ session_hash: string }>(pool(), `SELECT session_hash FROM staff_sessions`);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.session_hash).not.toBe(r.token);
    expect(stored[0]!.session_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    await admin();
    const wrong = await signIn(pool(), "asha@hospital.com", "not the password");
    const unknown = await signIn(pool(), "nobody@hospital.com", PASSWORD);
    expect(wrong).toEqual({ ok: false, reason: "invalid" });
    expect(unknown).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks the account after repeated wrong passwords, even for the right one", async () => {
    await admin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await signIn(pool(), "asha@hospital.com", "wrong password here");
    expect(await signIn(pool(), "asha@hospital.com", PASSWORD)).toEqual({ ok: false, reason: "locked" });
  });

  it("lets them back in once the lock has passed, and clears the count", async () => {
    await admin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await signIn(pool(), "asha@hospital.com", "wrong password here");
    await pool().query(`UPDATE staff_users SET locked_until = now() - interval '1 minute'`);
    const r = await signIn(pool(), "asha@hospital.com", PASSWORD);
    expect(r.ok).toBe(true);
    const row = await one<{ failed_attempts: number }>(pool(), `SELECT failed_attempts FROM staff_users`);
    expect(row!.failed_attempts).toBe(0);
  });

  it("does not count a successful sign-in towards the lock", async () => {
    await admin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await signIn(pool(), "asha@hospital.com", "wrong password here");
    expect((await signIn(pool(), "asha@hospital.com", PASSWORD)).ok).toBe(true);
    await signIn(pool(), "asha@hospital.com", "wrong password here");
    expect((await signIn(pool(), "asha@hospital.com", PASSWORD)).ok).toBe(true);
  });

  it("throttles one address that fails across many accounts", async () => {
    await admin();
    for (let i = 0; i < IP_FAILURE_LIMIT; i++) await signIn(pool(), `ghost${i}@hospital.com`, "guess guess guess", { ip: "203.0.113.9" });
    expect(await signIn(pool(), "asha@hospital.com", PASSWORD, { ip: "203.0.113.9" })).toEqual({ ok: false, reason: "throttled" });
    // A different address is unaffected.
    expect((await signIn(pool(), "asha@hospital.com", PASSWORD, { ip: "203.0.113.10" })).ok).toBe(true);
  });

  it("refuses a deactivated account without saying so", async () => {
    const a = await admin();
    const b = await createStaffUser(pool(), { email: "b@hospital.com", fullName: "Bina Shah", role: "receptionist", password: PASSWORD });
    await setUserActive(b.user_id, false);
    expect(await signIn(pool(), "b@hospital.com", PASSWORD)).toEqual({ ok: false, reason: "invalid" });
    expect(a.user_id).not.toBe(b.user_id);
  });
});

describe("sessions", () => {
  async function session(email: string) {
    const r = await signIn(pool(), email, PASSWORD);
    if (!r.ok) throw new Error("sign-in failed");
    return r.token;
  }

  it("ends on sign-out", async () => {
    await admin();
    const token = await session("asha@hospital.com");
    await endSession(pool(), token);
    expect(await userForSession(pool(), token)).toBeNull();
  });

  it("is rejected once expired", async () => {
    await admin();
    const token = await session("asha@hospital.com");
    await pool().query(`UPDATE staff_sessions SET expires_at = now() - interval '1 second'`);
    expect(await userForSession(pool(), token)).toBeNull();
  });

  it("is rejected for tokens that were never issued", async () => {
    expect(await userForSession(pool(), "made-up-token")).toBeNull();
    expect(await userForSession(pool(), undefined)).toBeNull();
    expect(await userForSession(pool(), "x".repeat(500))).toBeNull();
  });

  it("dies the moment the account is deactivated", async () => {
    await admin();
    const b = await createStaffUser(pool(), { email: "b@hospital.com", fullName: "Bina Shah", role: "receptionist", password: PASSWORD });
    const token = await session("b@hospital.com");
    expect(await userForSession(pool(), token)).not.toBeNull();
    await setUserActive(b.user_id, false);
    expect(await userForSession(pool(), token)).toBeNull();
  });

  it("dies when the role changes, so old permissions do not linger", async () => {
    await admin();
    const b = await createStaffUser(pool(), { email: "b@hospital.com", fullName: "Bina Shah", role: "receptionist", password: PASSWORD });
    const token = await session("b@hospital.com");
    await setUserRole(b.user_id, "nurse");
    expect(await userForSession(pool(), token)).toBeNull();
  });
});

describe("changing and resetting passwords", () => {
  it("needs the current password and signs out other devices", async () => {
    const u = await admin();
    const mine = await signIn(pool(), "asha@hospital.com", PASSWORD);
    const other = await signIn(pool(), "asha@hospital.com", PASSWORD);
    if (!mine.ok || !other.ok) throw new Error("sign-in failed");

    await expect(
      changePassword(pool(), { userId: u.user_id, current: "wrong password", next: "a brand new passphrase", keepSessionToken: mine.token }),
    ).rejects.toMatchObject({ code: "wrong_password" });

    await changePassword(pool(), { userId: u.user_id, current: PASSWORD, next: "a brand new passphrase", keepSessionToken: mine.token });
    expect(await userForSession(pool(), mine.token)).not.toBeNull();
    expect(await userForSession(pool(), other.token)).toBeNull();
    expect((await signIn(pool(), "asha@hospital.com", "a brand new passphrase")).ok).toBe(true);
    expect((await signIn(pool(), "asha@hospital.com", PASSWORD)).ok).toBe(false);
  });

  it("applies the same policy to a new password", async () => {
    const u = await admin();
    await expect(changePassword(pool(), { userId: u.user_id, current: PASSWORD, next: "short" })).rejects.toBeInstanceOf(AuthError);
  });

  it("issues a one-time password, ends every session and forces a change", async () => {
    const u = await admin();
    const r = await signIn(pool(), "asha@hospital.com", PASSWORD);
    if (!r.ok) throw new Error("sign-in failed");

    const temporary = await resetPassword(pool(), u.user_id);
    expect(await userForSession(pool(), r.token)).toBeNull();
    expect((await signIn(pool(), "asha@hospital.com", PASSWORD)).ok).toBe(false);

    const again = await signIn(pool(), "asha@hospital.com", temporary);
    expect(again.ok && again.user.must_change_password).toBe(true);
  });

  it("clears a lock when an administrator resets the password", async () => {
    const u = await admin();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await signIn(pool(), "asha@hospital.com", "wrong password here");
    const temporary = await resetPassword(pool(), u.user_id);
    expect((await signIn(pool(), "asha@hospital.com", temporary)).ok).toBe(true);
  });
});

describe("the last administrator", () => {
  it("cannot be deactivated or demoted", async () => {
    const a = await admin();
    await expect(setUserActive(a.user_id, false)).rejects.toMatchObject({ code: "last_admin" });
    await expect(setUserRole(a.user_id, "receptionist")).rejects.toMatchObject({ code: "last_admin" });
  });

  it("can step aside once another administrator exists", async () => {
    const a = await admin();
    await admin("second@hospital.com");
    await setUserActive(a.user_id, false);
    expect((await signIn(pool(), "asha@hospital.com", PASSWORD)).ok).toBe(false);
  });

  it("holds when two administrators deactivate each other at once", async () => {
    const a = await admin("a@hospital.com");
    const b = await admin("b@hospital.com");
    const results = await Promise.allSettled([setUserActive(a.user_id, false), setUserActive(b.user_id, false)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const active = await many(pool(), `SELECT 1 FROM staff_users WHERE role = 'admin' AND active`);
    expect(active).toHaveLength(1);
  });
});

describe("audit trail", () => {
  it("records who performed a staff action", async () => {
    const u = await admin();
    await runAs(u.user_id, () => audit(pool(), { workflow: "appointment", actor: "staff", action: "test_action", recordId: "X" }));
    const row = await one<{ actor_id: string | null }>(pool(), `SELECT actor_id FROM audit_log WHERE action = 'test_action'`);
    expect(row!.actor_id).toBe(u.user_id);
  });

  it("leaves system and patient events unattributed even inside a staff request", async () => {
    const u = await admin();
    await runAs(u.user_id, () => audit(pool(), { workflow: "messaging", actor: "system", action: "system_action" }));
    const row = await one<{ actor_id: string | null }>(pool(), `SELECT actor_id FROM audit_log WHERE action = 'system_action'`);
    expect(row!.actor_id).toBeNull();
  });

  it("records sign-ins and failures without the password", async () => {
    await admin();
    await signIn(pool(), "asha@hospital.com", "wrong password here");
    await signIn(pool(), "asha@hospital.com", PASSWORD);
    const rows = await many<{ action: string; details: unknown }>(pool(), `SELECT action, details FROM audit_log WHERE action LIKE 'login_%' ORDER BY event_id`);
    expect(rows.map((r) => r.action)).toEqual(["login_failed", "login_succeeded"]);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain("wrong password here");
  });
});
