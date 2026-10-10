import "../src/lib/load-env";
import { closePool, many, pool } from "../src/lib/db";
import { generatePassword } from "../src/server/auth/password";
import { createStaffUser } from "../src/server/auth/users";

/**
 * One account per role for a sales demo, so each can be shown signed in as that person.
 * Passwords are random and printed once; accounts that already exist are left untouched.
 * For demonstration servers only.
 *
 *   npm run user:demo
 */

const PEOPLE = [
  { email: "reception@democare.test", name: "Anita Deshmukh", role: "receptionist" as const },
  { email: "nurse@democare.test", name: "Nisha Verma", role: "nurse" as const },
  { email: "doctor@democare.test", name: "Dr. Ananya Rao", role: "doctor" as const, doctorId: "DOC-CAR-1" },
  { email: "pharmacy@democare.test", name: "Rohan Kulkarni", role: "pharmacist" as const },
  { email: "billing@democare.test", name: "Meena Krishnan", role: "billing" as const },
];

async function main() {
  const existing = new Set((await many<{ email: string }>(pool(), `SELECT lower(email) AS email FROM staff_users`)).map((r) => r.email));
  const created: { role: string; email: string; password: string }[] = [];

  for (const p of PEOPLE) {
    if (existing.has(p.email)) continue;
    const password = generatePassword();
    await createStaffUser(pool(), {
      email: p.email,
      fullName: p.name,
      role: p.role,
      doctorId: "doctorId" in p ? p.doctorId : null,
      password,
      mustChangePassword: false,
    });
    created.push({ role: p.role, email: p.email, password });
  }

  if (created.length === 0) {
    console.log("demo accounts already exist");
    return;
  }
  console.log("\nDemo accounts (shown once):");
  for (const c of created) console.log(`  ${c.role.padEnd(13)} ${c.email.padEnd(26)} ${c.password}`);
  console.log("");
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
