import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt from node:crypto (no native dependency to build on the server).
 * Parameters follow the OWASP minimum for scrypt: N=2^15, r=8, p=3.
 *
 * Stored as  scrypt$N$r$p$salt$hash  so the cost can be raised later and old hashes still verify.
 */

interface Cost {
  N: number;
  r: number;
  p: number;
}

const PRODUCTION_COST: Cost = { N: 32768, r: 8, p: 3 };
// Tests create dozens of accounts; the full cost would add minutes for no extra coverage.
const TEST_COST: Cost = { N: 1024, r: 8, p: 1 };

const KEY_LENGTH = 32;

function cost(): Cost {
  return process.env.NODE_ENV === "test" ? TEST_COST : PRODUCTION_COST;
}

function derive(password: string, salt: Buffer, c: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem is raised above scrypt's 32 MB default, which N=2^15 needs exactly.
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: c.N, r: c.r, p: c.p, maxmem: 128 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const c = cost();
  const salt = randomBytes(16);
  const key = await derive(password, salt, c);
  return ["scrypt", c.N, c.r, c.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  const expected = Buffer.from(parts[5]!, "base64url");
  const actual = await derive(password, Buffer.from(parts[4]!, "base64url"), { N, r, p });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Verified against when an email matches no account, so that "no such user" costs the same
 * time as "wrong password" and the response does not reveal which emails have accounts.
 */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(12).toString("base64url"));
  return decoy;
}

export const MIN_PASSWORD_LENGTH = 10;

/** Returns a message when the password is not acceptable, or null when it is. */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That password is too long.";
  if (/^(.)\1+$/.test(password)) return "Use more than one repeated character.";
  const lowered = password.toLowerCase();
  if (context.email && lowered === context.email.toLowerCase()) return "The password cannot be your email address.";
  if (context.name && lowered === context.name.toLowerCase()) return "The password cannot be your name.";
  if (["password", "1234567890", "qwertyuiop", "hospital123"].some((w) => lowered.includes(w))) {
    return "That password is too easy to guess.";
  }
  return null;
}

/** A readable one-time password: 16 characters, no look-alikes. */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
