import "../src/lib/load-env";
import { parseArgs } from "node:util";
import { closePool, many, pool } from "../src/lib/db";
import { isRole, ROLE_LABEL, ROLES } from "../src/lib/rbac";
import { generatePassword } from "../src/server/auth/password";
import { AuthError, createStaffUser, listStaff, resetPassword, setUserActive } from "../src/server/auth/users";

/**
 * Staff accounts from the command line. This is how the first administrator is created, and
 * how access is recovered if every administrator is locked out.
 *
 *   npm run user:create -- --role admin --name "Asha Rao" --email asha@hospital.com
 *   npm run user:create -- --role doctor --doctor DOC-CARD-1 --name "Dr Mehta" --email m@hospital.com
 *   npm run user:list
 *   npm run user:reset -- --email asha@hospital.com
 */

const USAGE = `usage:
  user create --role <${ROLES.join("|")}> --name "Full Name" --email you@example.com [--doctor DOCTOR_ID] [--password ...]
  user list
  user reset --email you@example.com
  user deactivate --email you@example.com`;

async function userIdForEmail(email: string): Promise<string> {
  const rows = await many<{ user_id: string }>(pool(), `SELECT user_id FROM staff_users WHERE lower(email) = lower($1)`, [email]);
  if (!rows[0]) throw new Error(`no account for ${email}`);
  return rows[0].user_id;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      role: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      doctor: { type: "string" },
      password: { type: "string" },
    },
  });

  switch (command) {
    case "create": {
      if (!values.role || !values.name || !values.email) throw new Error(USAGE);
      if (!isRole(values.role)) throw new Error(`unknown role "${values.role}". Roles: ${ROLES.join(", ")}`);
      // A password given on the command line lands in shell history, so generating one is the default.
      const password = values.password ?? generatePassword();
      const user = await createStaffUser(pool(), {
        email: values.email,
        fullName: values.name,
        role: values.role,
        doctorId: values.doctor ?? null,
        password,
        mustChangePassword: !values.password,
      });
      console.log(`\nCreated ${ROLE_LABEL[user.role]}: ${user.full_name} <${user.email}>`);
      if (!values.password) {
        console.log(`Temporary password: ${password}`);
        console.log("They will be asked to choose their own at first sign-in. It is not stored anywhere readable.\n");
      }
      break;
    }
    case "list": {
      const staff = await listStaff(pool());
      if (staff.length === 0) console.log("no accounts yet");
      for (const u of staff) {
        console.log(`${u.active ? "  " : "x "}${u.role.padEnd(13)} ${u.full_name.padEnd(26)} ${u.email}${u.doctor_name ? `  (${u.doctor_name})` : ""}`);
      }
      break;
    }
    case "reset": {
      if (!values.email) throw new Error(USAGE);
      const password = await resetPassword(pool(), await userIdForEmail(values.email));
      console.log(`\nNew temporary password for ${values.email}: ${password}`);
      console.log("All of their sessions were ended. They will choose their own at next sign-in.\n");
      break;
    }
    case "deactivate": {
      if (!values.email) throw new Error(USAGE);
      await setUserActive(await userIdForEmail(values.email), false);
      console.log(`${values.email} deactivated and signed out.`);
      break;
    }
    default:
      throw new Error(USAGE);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof AuthError ? `error: ${err.message}` : (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
