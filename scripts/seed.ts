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

/** A small starter formulary of common outpatient medicines. A hospital replaces it with its own. */
export const DEMO_MEDICINES = [
  { name: "Paracetamol 500 mg", generic: "Paracetamol", form: "tablet", unit: "tablet" },
  { name: "Paracetamol 650 mg", generic: "Paracetamol", form: "tablet", unit: "tablet" },
  { name: "Paracetamol 120 mg/5 ml", generic: "Paracetamol", form: "syrup", unit: "ml" },
  { name: "Ibuprofen 400 mg", generic: "Ibuprofen", form: "tablet", unit: "tablet" },
  { name: "Diclofenac 50 mg", generic: "Diclofenac", form: "tablet", unit: "tablet" },
  { name: "Aceclofenac 100 mg", generic: "Aceclofenac", form: "tablet", unit: "tablet" },
  { name: "Naproxen 250 mg", generic: "Naproxen", form: "tablet", unit: "tablet" },
  { name: "Tramadol 50 mg", generic: "Tramadol", form: "capsule", unit: "capsule" },
  { name: "Amoxicillin 500 mg", generic: "Amoxicillin", form: "capsule", unit: "capsule" },
  { name: "Amoxicillin + Clavulanic acid 625 mg", generic: "Amoxicillin + Clavulanic acid", form: "tablet", unit: "tablet" },
  { name: "Azithromycin 500 mg", generic: "Azithromycin", form: "tablet", unit: "tablet" },
  { name: "Cefixime 200 mg", generic: "Cefixime", form: "tablet", unit: "tablet" },
  { name: "Ciprofloxacin 500 mg", generic: "Ciprofloxacin", form: "tablet", unit: "tablet" },
  { name: "Doxycycline 100 mg", generic: "Doxycycline", form: "capsule", unit: "capsule" },
  { name: "Metronidazole 400 mg", generic: "Metronidazole", form: "tablet", unit: "tablet" },
  { name: "Cetirizine 10 mg", generic: "Cetirizine", form: "tablet", unit: "tablet" },
  { name: "Levocetirizine 5 mg", generic: "Levocetirizine", form: "tablet", unit: "tablet" },
  { name: "Montelukast 10 mg", generic: "Montelukast", form: "tablet", unit: "tablet" },
  { name: "Pantoprazole 40 mg", generic: "Pantoprazole", form: "tablet", unit: "tablet" },
  { name: "Omeprazole 20 mg", generic: "Omeprazole", form: "capsule", unit: "capsule" },
  { name: "Ranitidine 150 mg", generic: "Ranitidine", form: "tablet", unit: "tablet" },
  { name: "Domperidone 10 mg", generic: "Domperidone", form: "tablet", unit: "tablet" },
  { name: "Ondansetron 4 mg", generic: "Ondansetron", form: "tablet", unit: "tablet" },
  { name: "Oral rehydration salts", generic: "Oral rehydration salts", form: "sachet", unit: "sachet" },
  { name: "Metformin 500 mg", generic: "Metformin", form: "tablet", unit: "tablet" },
  { name: "Glimepiride 2 mg", generic: "Glimepiride", form: "tablet", unit: "tablet" },
  { name: "Amlodipine 5 mg", generic: "Amlodipine", form: "tablet", unit: "tablet" },
  { name: "Telmisartan 40 mg", generic: "Telmisartan", form: "tablet", unit: "tablet" },
  { name: "Losartan 50 mg", generic: "Losartan", form: "tablet", unit: "tablet" },
  { name: "Atenolol 50 mg", generic: "Atenolol", form: "tablet", unit: "tablet" },
  { name: "Metoprolol 50 mg", generic: "Metoprolol", form: "tablet", unit: "tablet" },
  { name: "Atorvastatin 20 mg", generic: "Atorvastatin", form: "tablet", unit: "tablet" },
  { name: "Rosuvastatin 10 mg", generic: "Rosuvastatin", form: "tablet", unit: "tablet" },
  { name: "Aspirin 75 mg", generic: "Aspirin", form: "tablet", unit: "tablet" },
  { name: "Clopidogrel 75 mg", generic: "Clopidogrel", form: "tablet", unit: "tablet" },
  { name: "Furosemide 40 mg", generic: "Furosemide", form: "tablet", unit: "tablet" },
  { name: "Salbutamol 100 mcg inhaler", generic: "Salbutamol", form: "inhaler", unit: "puff" },
  { name: "Levothyroxine 50 mcg", generic: "Levothyroxine", form: "tablet", unit: "tablet" },
  { name: "Vitamin D3 60000 IU", generic: "Cholecalciferol", form: "sachet", unit: "sachet" },
  { name: "Calcium + Vitamin D3", generic: "Calcium carbonate + Cholecalciferol", form: "tablet", unit: "tablet" },
  { name: "Multivitamin", generic: "Multivitamin", form: "capsule", unit: "capsule" },
  { name: "Folic acid 5 mg", generic: "Folic acid", form: "tablet", unit: "tablet" },
  { name: "Iron + Folic acid", generic: "Ferrous ascorbate + Folic acid", form: "tablet", unit: "tablet" },
  { name: "Clotrimazole 1% cream", generic: "Clotrimazole", form: "cream", unit: "application" },
  { name: "Betamethasone 0.05% cream", generic: "Betamethasone", form: "cream", unit: "application" },
  { name: "Mupirocin 2% ointment", generic: "Mupirocin", form: "ointment", unit: "application" },
  { name: "Fusidic acid 2% cream", generic: "Fusidic acid", form: "cream", unit: "application" },
  { name: "Permethrin 5% lotion", generic: "Permethrin", form: "lotion", unit: "application" },
  { name: "Itraconazole 100 mg", generic: "Itraconazole", form: "capsule", unit: "capsule" },
  { name: "Fluconazole 150 mg", generic: "Fluconazole", form: "tablet", unit: "tablet" },
  { name: "Pregabalin 75 mg", generic: "Pregabalin", form: "capsule", unit: "capsule" },
  { name: "Thiocolchicoside 4 mg", generic: "Thiocolchicoside", form: "tablet", unit: "tablet" },
  { name: "Diclofenac 1% gel", generic: "Diclofenac", form: "gel", unit: "application" },
  { name: "Ambroxol 30 mg/5 ml", generic: "Ambroxol", form: "syrup", unit: "ml" },
  { name: "Dextromethorphan syrup", generic: "Dextromethorphan", form: "syrup", unit: "ml" },
  { name: "Povidone-iodine 5% solution", generic: "Povidone-iodine", form: "solution", unit: "application" },
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

    for (const [i, m] of DEMO_MEDICINES.entries()) {
      await client.query(
        `INSERT INTO medicines (medicine_id, name, generic_name, form, unit) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lower(name)) DO NOTHING`,
        [`MED-${String(i + 1).padStart(3, "0")}`, m.name, m.generic, m.form, m.unit],
      );
    }

    // Starter stock so the pharmacy has something to dispense in a demo. Only for medicines
    // that have no batches yet, so re-running the seed never doubles anything.
    const today0 = istDateString();
    const stocked = await client.query<{ medicine_id: string; name: string }>(
      `SELECT m.medicine_id, m.name FROM medicines m
        WHERE NOT EXISTS (SELECT 1 FROM medicine_batches b WHERE b.medicine_id = m.medicine_id)`,
    );
    for (const m of stocked.rows) {
      const h = [...m.name].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
      const price = 2 + (h % 180) / 4; // Rs 2 to Rs 47 per unit, stable per medicine
      const batches: [string, number, number][] = [
        [`A${(h % 900) + 100}`, 120 + (h % 5) * 40, 110],  // expires in ~4 months
        [`B${(h % 700) + 200}`, 200 + (h % 7) * 50, 540],  // expires in ~18 months
      ];
      for (const [number, qty, days] of batches) {
        const id = `BAT-${m.medicine_id}-${number}`;
        await client.query(
          `INSERT INTO medicine_batches (batch_id, medicine_id, batch_number, expiry_date, quantity_received, quantity_on_hand, unit_cost, unit_price, supplier)
           VALUES ($1, $2, $3, $4::date + $5::int, $6, $6, $7, $8, 'Demo Distributors')
           ON CONFLICT (medicine_id, batch_number) DO NOTHING`,
          [id, m.medicine_id, number, today0, days, qty, Math.round(price * 0.7 * 100) / 100, Math.round(price * 100) / 100],
        );
        await client.query(
          `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference)
           SELECT $1, $2, 'receipt', $3, 'opening stock'
            WHERE EXISTS (SELECT 1 FROM medicine_batches WHERE batch_id = $2)
              AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE batch_id = $2)`,
          [m.medicine_id, id, qty],
        );
      }
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
      console.log(`seeded ${DEMO_DEPARTMENTS.length} departments, ${DEMO_DOCTORS.length} doctors, ${DEMO_MEDICINES.length} medicines, ${created} new slots (${days} days)`);
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
