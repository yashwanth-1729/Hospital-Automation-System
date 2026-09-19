import "../src/lib/load-env";
import pg from "pg";
import { addDays, istAt, istDateString } from "../src/lib/time";

/** Fictional demo facility (blueprint section D). No real people or patients. */
export const DEMO_DEPARTMENTS = [
  { id: "cardiology", name: "Cardiology" },
  { id: "dermatology", name: "Dermatology" },
  { id: "orthopedics", name: "Orthopedics" },
  { id: "general_medicine", name: "General Medicine" },
];

export const DEMO_DOCTORS = [
  { id: "DOC-CAR-1", dept: "cardiology", name: "Dr. Ananya Rao" },
  { id: "DOC-CAR-2", dept: "cardiology", name: "Dr. Vikram Menon" },
  { id: "DOC-DER-1", dept: "dermatology", name: "Dr. Priya Nair" },
  { id: "DOC-DER-2", dept: "dermatology", name: "Dr. Karan Mehta" },
  { id: "DOC-ORT-1", dept: "orthopedics", name: "Dr. Suresh Reddy" },
  { id: "DOC-ORT-2", dept: "orthopedics", name: "Dr. Meera Iyer" },
  { id: "DOC-GEN-1", dept: "general_medicine", name: "Dr. Arjun Sharma" },
  { id: "DOC-GEN-2", dept: "general_medicine", name: "Dr. Kavya Pillai" },
];

/** OPD session times (IST) generated for every doctor, Monday-Saturday. */
const SESSION_TIMES: [number, number][] = [
  [10, 0], [10, 30], [11, 0], [11, 30], [12, 0],
  [16, 0], [16, 30], [17, 0],
];
const SLOT_MINUTES = 30;

export async function seed(connectionString: string, opts: { days?: number; quiet?: boolean } = {}) {
  const days = opts.days ?? 14;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const d of DEMO_DEPARTMENTS) {
      await client.query(
        `INSERT INTO departments (department_id, name) VALUES ($1, $2)
         ON CONFLICT (department_id) DO UPDATE SET name = EXCLUDED.name`,
        [d.id, d.name],
      );
    }
    for (const doc of DEMO_DOCTORS) {
      await client.query(
        `INSERT INTO doctors (doctor_id, department_id, full_name) VALUES ($1, $2, $3)
         ON CONFLICT (doctor_id) DO UPDATE SET full_name = EXCLUDED.full_name, department_id = EXCLUDED.department_id`,
        [doc.id, doc.dept, doc.name],
      );
    }

    let created = 0;
    const today = istDateString();
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      const weekday = new Date(`${date}T12:00:00+05:30`).getUTCDay();
      if (weekday === 0) continue; // OPD closed on Sundays.
      for (const doc of DEMO_DOCTORS) {
        for (const [h, m] of SESSION_TIMES) {
          const start = istAt(date, h, m);
          const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
          const r = await client.query(
            `INSERT INTO slots (slot_id, doctor_id, department_id, slot_start, slot_end)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (doctor_id, slot_start) DO NOTHING`,
            [`SLOT-${doc.id}-${date.replaceAll("-", "")}-${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`, doc.id, doc.dept, start, end],
          );
          created += r.rowCount ?? 0;
        }
      }
    }
    await client.query("COMMIT");
    if (!opts.quiet) {
      console.log(`seeded ${DEMO_DEPARTMENTS.length} departments, ${DEMO_DOCTORS.length} doctors, ${created} new slots (${days} days)`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  seed(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
