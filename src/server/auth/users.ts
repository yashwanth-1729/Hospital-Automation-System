import { createHash, randomBytes } from "node:crypto";
import { audit } from "@/lib/audit";
import { many, one, tx, type Db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { isRole, type Role } from "@/lib/rbac";
import { decoyHash, generatePassword, hashPassword, passwordProblem, verifyPassword } from "./password";

export interface StaffUser {
  user_id: string;
  email: string;
  full_name: string;
  role: Role;
  doctor_id: string | null;
  active: boolean;
  must_change_password: boolean;
  last_login_at: Date | null;
}

export type AuthErrorCode =
  | "invalid_email"
  | "invalid_name"
  | "invalid_role"
  | "doctor_required"
  | "doctor_not_found"
  | "doctor_taken"
  | "weak_password"
  | "email_taken"
  | "not_found"
  | "wrong_password"
  | "last_admin";

/** A rejected request with a reason the caller can show, as opposed to a bug. */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const COLUMNS = `user_id, email, full_name, role, doctor_id, active, must_change_password, last_login_at`;

export const SESSION_HOURS = 12;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const IP_FAILURE_LIMIT = 30;
export const IP_WINDOW_MINUTES = 10;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// --- accounts -----------------------------------------------------------------------------

export interface NewStaffUser {
  email: string;
  fullName: string;
  role: Role;
  doctorId?: string | null;
  password: string;
  mustChangePassword?: boolean;
}

export async function createStaffUser(db: Db, input: NewStaffUser): Promise<StaffUser> {
  const email = normaliseEmail(input.email);
  const fullName = input.fullName.trim();
  if (!EMAIL.test(email)) throw new AuthError("invalid_email", "Enter a valid email address.");
  if (fullName.length < 2 || fullName.length > 120) throw new AuthError("invalid_name", "Enter the person's full name.");
  if (!isRole(input.role)) throw new AuthError("invalid_role", "Choose a role.");
  const problem = passwordProblem(input.password, { email, name: fullName });
  if (problem) throw new AuthError("weak_password", problem);

  let doctorId: string | null = null;
  if (input.role === "doctor") {
    if (!input.doctorId) throw new AuthError("doctor_required", "A doctor account must be linked to a doctor record.");
    const doc = await one(db, `SELECT doctor_id FROM doctors WHERE doctor_id = $1`, [input.doctorId]);
    if (!doc) throw new AuthError("doctor_not_found", "That doctor record does not exist.");
    const taken = await one(db, `SELECT 1 FROM staff_users WHERE doctor_id = $1`, [input.doctorId]);
    if (taken) throw new AuthError("doctor_taken", "That doctor already has a login.");
    doctorId = input.doctorId;
  }

  const hash = await hashPassword(input.password);
  try {
    const user = await one<StaffUser>(
      db,
      `INSERT INTO staff_users (user_id, email, full_name, role, doctor_id, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [newId("USR"), email, fullName, input.role, doctorId, hash, input.mustChangePassword ?? false],
    );
    await audit(db, { workflow: "access", actor: "staff", action: "user_created", recordId: user!.user_id, details: { role: input.role } });
    return user!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new AuthError("email_taken", "That email already has an account.");
    throw err;
  }
}

export async function listStaff(db: Db): Promise<(StaffUser & { doctor_name: string | null })[]> {
  return many(
    db,
    `SELECT u.user_id, u.email, u.full_name, u.role, u.doctor_id, u.active, u.must_change_password, u.last_login_at,
            d.full_name AS doctor_name
       FROM staff_users u LEFT JOIN doctors d ON d.doctor_id = u.doctor_id
      WHERE u.user_id <> 'USR-DEMO-HISTORY'
      ORDER BY u.active DESC, u.role, u.full_name`,
  );
}

export async function countActiveAdmins(db: Db): Promise<number> {
  const r = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM staff_users WHERE role = 'admin' AND active`);
  return r?.n ?? 0;
}

/**
 * Takes the other active admins under a row lock, so two admins deactivating each other at the
 * same moment cannot leave the hospital with nobody able to sign in as an administrator.
 */
async function requireAnotherAdmin(db: Db, userId: string): Promise<void> {
  const others = await many(db, `SELECT user_id FROM staff_users WHERE role = 'admin' AND active AND user_id <> $1 FOR UPDATE`, [userId]);
  if (others.length === 0) throw new AuthError("last_admin", "There must always be at least one active administrator.");
}

export async function setUserActive(userId: string, active: boolean): Promise<void> {
  await tx(async (c) => {
    const user = await one<{ role: Role; active: boolean }>(c, `SELECT role, active FROM staff_users WHERE user_id = $1 FOR UPDATE`, [userId]);
    if (!user) throw new AuthError("not_found", "No such account.");
    if (!active && user.role === "admin" && user.active) await requireAnotherAdmin(c, userId);
    await c.query(`UPDATE staff_users SET active = $2, updated_at = now() WHERE user_id = $1`, [userId, active]);
    if (!active) await c.query(`DELETE FROM staff_sessions WHERE user_id = $1`, [userId]);
    await audit(c, { workflow: "access", actor: "staff", action: active ? "user_activated" : "user_deactivated", recordId: userId });
  });
}

export async function setUserRole(userId: string, role: Role, doctorId?: string | null): Promise<void> {
  if (!isRole(role)) throw new AuthError("invalid_role", "Choose a role.");
  await tx(async (c) => {
    const user = await one<{ role: Role; active: boolean; doctor_id: string | null }>(
      c,
      `SELECT role, active, doctor_id FROM staff_users WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!user) throw new AuthError("not_found", "No such account.");
    if (user.role === "admin" && role !== "admin" && user.active) await requireAnotherAdmin(c, userId);

    let linked: string | null = null;
    if (role === "doctor") {
      // A doctor keeps the record they already have unless a different one is chosen.
      const wanted = doctorId ?? user.doctor_id;
      if (!wanted) throw new AuthError("doctor_required", "A doctor account must be linked to a doctor record.");
      const taken = await one(c, `SELECT 1 FROM staff_users WHERE doctor_id = $1 AND user_id <> $2`, [wanted, userId]);
      if (taken) throw new AuthError("doctor_taken", "That doctor already has a login.");
      linked = wanted;
    }
    await c.query(`UPDATE staff_users SET role = $2, doctor_id = $3, updated_at = now() WHERE user_id = $1`, [userId, role, linked]);
    // Their open sessions were granted under the old role; make them sign in again.
    await c.query(`DELETE FROM staff_sessions WHERE user_id = $1`, [userId]);
    await audit(c, { workflow: "access", actor: "staff", action: "user_role_changed", recordId: userId, details: { from: user.role, to: role } });
  });
}

/** Sets a new one-time password and signs the person out everywhere. Returns it once. */
export async function resetPassword(db: Db, userId: string): Promise<string> {
  const password = generatePassword();
  const hash = await hashPassword(password);
  const r = await db.query(
    `UPDATE staff_users
        SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE user_id = $1`,
    [userId, hash],
  );
  if (r.rowCount === 0) throw new AuthError("not_found", "No such account.");
  await db.query(`DELETE FROM staff_sessions WHERE user_id = $1`, [userId]);
  await audit(db, { workflow: "access", actor: "staff", action: "password_reset", recordId: userId });
  return password;
}

export async function changePassword(
  db: Db,
  opts: { userId: string; current: string; next: string; keepSessionToken?: string },
): Promise<void> {
  const row = await one<{ password_hash: string; email: string; full_name: string }>(
    db,
    `SELECT password_hash, email, full_name FROM staff_users WHERE user_id = $1 AND active`,
    [opts.userId],
  );
  if (!row) throw new AuthError("not_found", "No such account.");
  if (!(await verifyPassword(opts.current, row.password_hash))) {
    throw new AuthError("wrong_password", "Your current password is not correct.");
  }
  const problem = passwordProblem(opts.next, { email: row.email, name: row.full_name });
  if (problem) throw new AuthError("weak_password", problem);
  if (opts.next === opts.current) throw new AuthError("weak_password", "Choose a password you have not used just now.");

  const hash = await hashPassword(opts.next);
  await db.query(`UPDATE staff_users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE user_id = $1`, [
    opts.userId,
    hash,
  ]);
  // Anyone else holding a session (a lost phone, a shared PC) is signed out.
  await db.query(`DELETE FROM staff_sessions WHERE user_id = $1 AND session_hash <> $2`, [
    opts.userId,
    opts.keepSessionToken ? sessionHash(opts.keepSessionToken) : "",
  ]);
  await audit(db, { workflow: "access", actor: "staff", action: "password_changed", recordId: opts.userId, actorId: opts.userId });
}

// --- sign-in ------------------------------------------------------------------------------

export type SignInResult =
  | { ok: true; user: StaffUser; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid" | "locked" | "throttled" };

export interface SignInContext {
  ip?: string | null;
  userAgent?: string | null;
}

export async function signIn(db: Db, email: string, password: string, ctx: SignInContext = {}): Promise<SignInResult> {
  const ip = ctx.ip ?? "unknown";
  const address = normaliseEmail(email);

  const recent = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM login_failures WHERE ip = $1 AND at > now() - make_interval(mins => $2)`,
    [ip, IP_WINDOW_MINUTES],
  );
  if ((recent?.n ?? 0) >= IP_FAILURE_LIMIT) return { ok: false, reason: "throttled" };

  const row = await one<StaffUser & { password_hash: string; locked_until: Date | null }>(
    db,
    `SELECT ${COLUMNS}, password_hash, locked_until FROM staff_users WHERE lower(email) = $1`,
    [address],
  );

  const fail = async (action: string, userId: string | null): Promise<void> => {
    await db.query(`INSERT INTO login_failures (ip, email) VALUES ($1, $2)`, [ip, address.slice(0, 200)]);
    await db.query(`DELETE FROM login_failures WHERE at < now() - interval '1 day'`);
    await audit(db, { workflow: "access", actor: "staff", action, recordId: userId, details: { ip }, actorId: userId });
  };

  if (!row) {
    await verifyPassword(password, await decoyHash());
    await fail("login_failed", null);
    return { ok: false, reason: "invalid" };
  }

  if (row.locked_until && row.locked_until > new Date()) {
    await verifyPassword(password, row.password_hash); // same cost whether or not they are locked
    return { ok: false, reason: "locked" };
  }

  const correct = await verifyPassword(password, row.password_hash);
  if (!correct || !row.active) {
    if (row.active) {
      // One statement so concurrent guesses cannot all slip under the limit.
      await db.query(
        `UPDATE staff_users
            SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE user_id = $1`,
        [row.user_id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
      );
    }
    await fail("login_failed", row.user_id);
    return { ok: false, reason: "invalid" };
  }

  await db.query(`UPDATE staff_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE user_id = $1`, [row.user_id]);
  const session = await createSession(db, row.user_id, ctx);
  await audit(db, { workflow: "access", actor: "staff", action: "login_succeeded", recordId: row.user_id, details: { ip }, actorId: row.user_id });

  const user: StaffUser = {
    user_id: row.user_id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    doctor_id: row.doctor_id,
    active: row.active,
    must_change_password: row.must_change_password,
    last_login_at: new Date(),
  };
  return { ok: true, user, token: session.token, expiresAt: session.expiresAt };
}

// --- sessions -----------------------------------------------------------------------------

export async function createSession(db: Db, userId: string, ctx: SignInContext = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.query(
    `INSERT INTO staff_sessions (session_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [sessionHash(token), userId, expiresAt, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null],
  );
  await db.query(`DELETE FROM staff_sessions WHERE expires_at < now() - interval '1 day'`);
  return { token, expiresAt };
}

/** The account behind a session token, or null if it is unknown, expired, or deactivated. */
export async function userForSession(db: Db, token: string | undefined | null): Promise<StaffUser | null> {
  if (!token || token.length > 200) return null;
  const user = await one<StaffUser>(
    db,
    `SELECT u.user_id, u.email, u.full_name, u.role, u.doctor_id, u.active, u.must_change_password, u.last_login_at
       FROM staff_sessions s JOIN staff_users u ON u.user_id = s.user_id
      WHERE s.session_hash = $1 AND s.expires_at > now() AND u.active`,
    [sessionHash(token)],
  );
  return user ?? null;
}

export async function endSession(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.query(`DELETE FROM staff_sessions WHERE session_hash = $1`, [sessionHash(token)]);
}
