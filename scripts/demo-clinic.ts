import "../src/lib/load-env";
import pg from "pg";
import { stayDays } from "../src/lib/bed-days";
import { newCorrelationId, newId } from "../src/lib/ids";
import { quantityFor, type Frequency } from "../src/lib/prescribing";
import { addDays, istAt, istDateString } from "../src/lib/time";
import { seed } from "./seed";

/**
 * Backdated clinical history for a sales demo: a few weeks of OPD visits with vitals,
 * consultations, prescriptions, dispensing, invoices and payments, plus current and past
 * inpatients. Written directly (history has to be backdated), but kept consistent: stock
 * counts equal their ledger, every invoice line has its source, totals add up.
 *
 * Runs after scripts/demo-data.ts, which provides the patients. Never run it on a real
 * hospital's database: it is called only from the demo generator.
 */

// A small seeded generator, so a demo is the same every time it is built.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  name: string;
  dose: number;
  freq: Frequency;
  days: number;
  timing: "any" | "before_food" | "after_food" | "with_food";
}

interface Pattern {
  complaint: string;
  diagnosis: string;
  advice: string;
  items: Item[];
}

const PATTERNS: Record<string, Pattern[]> = {
  cardiology: [
    { complaint: "Headache and giddiness for a week", diagnosis: "Hypertension", advice: "Reduce salt. Walk 30 minutes daily. Review in a month.", items: [
      { name: "Amlodipine 5 mg", dose: 1, freq: "OD", days: 30, timing: "any" }, { name: "Aspirin 75 mg", dose: 1, freq: "OD", days: 30, timing: "after_food" }] },
    { complaint: "Chest tightness on climbing stairs", diagnosis: "Stable angina", advice: "Avoid exertion until reviewed. Report any pain at rest at once.", items: [
      { name: "Atenolol 50 mg", dose: 1, freq: "OD", days: 30, timing: "any" }, { name: "Atorvastatin 20 mg", dose: 1, freq: "HS", days: 30, timing: "after_food" }, { name: "Aspirin 75 mg", dose: 1, freq: "OD", days: 30, timing: "after_food" }] },
    { complaint: "Palpitations, worse in the evening", diagnosis: "Anxiety with palpitations", advice: "Cut down tea and coffee. Sleep on time.", items: [{ name: "Metoprolol 50 mg", dose: 0.5, freq: "BD", days: 14, timing: "after_food" }] },
    { complaint: "Routine review, on treatment for cholesterol", diagnosis: "Dyslipidaemia, controlled", advice: "Continue the same tablets. Repeat blood tests in three months.", items: [{ name: "Rosuvastatin 10 mg", dose: 1, freq: "HS", days: 30, timing: "any" }] },
  ],
  dermatology: [
    { complaint: "Itchy red patches on both arms", diagnosis: "Eczema", advice: "Moisturise twice daily. Avoid hot showers and harsh soaps.", items: [
      { name: "Betamethasone 0.05% cream", dose: 1, freq: "BD", days: 7, timing: "any" }, { name: "Cetirizine 10 mg", dose: 1, freq: "HS", days: 7, timing: "any" }] },
    { complaint: "Circular itchy rash on the groin", diagnosis: "Tinea cruris (fungal infection)", advice: "Keep the area dry. Wash and dry clothes in sunlight.", items: [
      { name: "Clotrimazole 1% cream", dose: 1, freq: "BD", days: 14, timing: "any" }, { name: "Fluconazole 150 mg", dose: 1, freq: "OD", days: 7, timing: "after_food" }] },
    { complaint: "Pimples on the face for several months", diagnosis: "Acne vulgaris", advice: "Do not squeeze lesions. Use a gentle face wash.", items: [
      { name: "Doxycycline 100 mg", dose: 1, freq: "OD", days: 30, timing: "after_food" }, { name: "Fusidic acid 2% cream", dose: 1, freq: "BD", days: 14, timing: "any" }] },
    { complaint: "Itching at night, family members also affected", diagnosis: "Scabies", advice: "Treat all household members. Wash bed linen in hot water.", items: [
      { name: "Permethrin 5% lotion", dose: 1, freq: "OD", days: 2, timing: "any" }, { name: "Levocetirizine 5 mg", dose: 1, freq: "HS", days: 7, timing: "any" }] },
  ],
  orthopedics: [
    { complaint: "Pain in the right knee on walking", diagnosis: "Osteoarthritis of the knee", advice: "Avoid sitting cross-legged. Knee strengthening exercises daily.", items: [
      { name: "Aceclofenac 100 mg", dose: 1, freq: "BD", days: 7, timing: "after_food" }, { name: "Pantoprazole 40 mg", dose: 1, freq: "OD", days: 7, timing: "before_food" }, { name: "Calcium + Vitamin D3", dose: 1, freq: "OD", days: 30, timing: "after_food" }] },
    { complaint: "Lower back pain after lifting a heavy load", diagnosis: "Lumbar muscle strain", advice: "Rest for two days, then gentle walking. Hot compress.", items: [
      { name: "Thiocolchicoside 4 mg", dose: 1, freq: "BD", days: 5, timing: "after_food" }, { name: "Diclofenac 1% gel", dose: 1, freq: "BD", days: 7, timing: "any" }] },
    { complaint: "Neck stiffness and pain radiating to the shoulder", diagnosis: "Cervical spondylosis", advice: "Check your desk and screen height. Neck exercises as shown.", items: [
      { name: "Pregabalin 75 mg", dose: 1, freq: "HS", days: 14, timing: "after_food" }, { name: "Diclofenac 50 mg", dose: 1, freq: "BD", days: 5, timing: "after_food" }] },
  ],
  general_medicine: [
    { complaint: "Fever with body ache for two days", diagnosis: "Viral fever", advice: "Rest and plenty of fluids. Return if fever lasts beyond three days.", items: [
      { name: "Paracetamol 650 mg", dose: 1, freq: "TDS", days: 3, timing: "after_food" }] },
    { complaint: "Cough and sore throat for five days", diagnosis: "Upper respiratory tract infection", advice: "Warm saline gargles. Steam inhalation twice daily.", items: [
      { name: "Azithromycin 500 mg", dose: 1, freq: "OD", days: 3, timing: "after_food" }, { name: "Cetirizine 10 mg", dose: 1, freq: "HS", days: 5, timing: "any" }, { name: "Dextromethorphan syrup", dose: 10, freq: "TDS", days: 5, timing: "any" }] },
    { complaint: "Loose motions since yesterday", diagnosis: "Acute gastroenteritis", advice: "Oral rehydration after every motion. Light food. Wash hands before eating.", items: [
      { name: "Oral rehydration salts", dose: 1, freq: "TDS", days: 3, timing: "any" }, { name: "Ondansetron 4 mg", dose: 1, freq: "BD", days: 2, timing: "before_food" }, { name: "Metronidazole 400 mg", dose: 1, freq: "TDS", days: 5, timing: "after_food" }] },
    { complaint: "Increased thirst and tiredness", diagnosis: "Type 2 diabetes mellitus", advice: "Diet plan given. Check fasting sugar weekly.", items: [
      { name: "Metformin 500 mg", dose: 1, freq: "BD", days: 30, timing: "after_food" }, { name: "Glimepiride 2 mg", dose: 1, freq: "OD", days: 30, timing: "before_food" }] },
    { complaint: "Burning in the upper abdomen after meals", diagnosis: "Gastritis", advice: "Small frequent meals. Avoid spicy food and late dinners.", items: [
      { name: "Pantoprazole 40 mg", dose: 1, freq: "OD", days: 14, timing: "before_food" }, { name: "Domperidone 10 mg", dose: 1, freq: "BD", days: 7, timing: "before_food" }] },
  ],
};

const METHODS: [string, number][] = [["cash", 45], ["upi", 40], ["card", 15]];

export async function generateClinicHistory(connectionString: string, opts: { days?: number } = {}): Promise<void> {
  const days = opts.days ?? 21;
  const rand = rng(20261010);
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const chance = (p: number) => rand() < p;
  const weighted = <T,>(xs: [T, number][]): T => {
    const total = xs.reduce((n, [, w]) => n + w, 0);
    let r = rand() * total;
    for (const [x, w] of xs) if ((r -= w) <= 0) return x;
    return xs[0]![0];
  };

  // Start from a clean pharmacy and ward, so running the demo builder twice gives the same hospital.
  {
    const reset = new pg.Client({ connectionString });
    await reset.connect();
    try {
      await reset.query(`UPDATE beds SET status = 'available'`);
      await reset.query(`DELETE FROM stock_movements`);
      await reset.query(`DELETE FROM medicine_batches`);
      await reset.query(`UPDATE medicines SET reorder_level = 20`);
      await reset.query(`ALTER SEQUENCE invoice_seq RESTART`);
      await reset.query(`ALTER SEQUENCE receipt_seq RESTART`);
    } finally {
      await reset.end();
    }
    await seed(connectionString, { days: 0, quiet: true }); // restocks medicines that have no batches
  }

  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query("BEGIN");

    // The author of history. Inactive, with a password hash that matches nothing, so it cannot sign in.
    await c.query(
      `INSERT INTO staff_users (user_id, email, full_name, role, password_hash, active)
       VALUES ('USR-DEMO-HISTORY', 'demo-history@invalid.local', 'Recorded history (demo)', 'admin', 'scrypt$0$0$0$-$-', false)
       ON CONFLICT (user_id) DO NOTHING`,
    );
    const AUTHOR = "USR-DEMO-HISTORY";

    const today = istDateString();
    const doctors = (await c.query<{ doctor_id: string; department_id: string; full_name: string; fee: string }>(
      `SELECT doctor_id, department_id, full_name, consultation_fee::text AS fee FROM doctors WHERE active ORDER BY doctor_id`,
    )).rows;
    const patientIds = (await c.query<{ patient_id: string }>(`SELECT patient_id FROM patients ORDER BY patient_id`)).rows.map((r) => r.patient_id);
    if (patientIds.length < 20) throw new Error("run scripts/demo-data.ts first: the demo needs patients to build history on");

    // Give the demo patients ages and genders, as a real registration would have.
    await c.query(
      `UPDATE patients SET gender = (ARRAY['female','male'])[1 + floor(random() * 2)::int],
                           date_of_birth = (current_date - make_interval(years => 18 + floor(random() * 62)::int, days => floor(random() * 300)::int))::date,
                           dob_estimated = true
        WHERE gender IS NULL AND date_of_birth IS NULL`,
    );
    // A few allergies, so the safety net has something to show.
    await c.query(
      `UPDATE patients SET allergies = 'Penicillin' WHERE patient_id IN (SELECT patient_id FROM patients ORDER BY patient_id LIMIT 4)`,
    );

    // --- stock: enough history behind it that the shelves do not run dry --------------------------
    const meds = new Map((await c.query<{ medicine_id: string; name: string }>(`SELECT medicine_id, name FROM medicines`)).rows.map((m) => [m.name, m.medicine_id]));
    const usedNames = new Set(Object.values(PATTERNS).flat().flatMap((p) => p.items.map((i) => i.name)));
    for (const name of usedNames) {
      const id = meds.get(name);
      if (!id) continue;
      const batch = (await c.query<{ batch_id: string }>(
        `SELECT batch_id FROM medicine_batches WHERE medicine_id = $1 ORDER BY expiry_date DESC, batch_id LIMIT 1`,
        [id],
      )).rows[0];
      if (!batch) continue;
      const qty = 900;
      await c.query(`UPDATE medicine_batches SET quantity_received = quantity_received + $2, quantity_on_hand = quantity_on_hand + $2 WHERE batch_id = $1`, [batch.batch_id, qty]);
      await c.query(
        `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference, created_at)
         VALUES ($1, $2, 'receipt', $3, 'restock', $4)`,
        [id, batch.batch_id, qty, istAt(addDays(today, -(days + 1)), 11)],
      );
    }

    const batchFor = async (medicineId: string) =>
      (await c.query<{ batch_id: string; unit_price: string; quantity_on_hand: number }>(
        `SELECT batch_id, unit_price::text, quantity_on_hand FROM medicine_batches
          WHERE medicine_id = $1 AND quantity_on_hand > 0 AND expiry_date >= $2::date
          ORDER BY expiry_date DESC, batch_id LIMIT 1`,
        [medicineId, today],
      )).rows[0];

    const tokenCounters = new Map<string, number>();
    const year = today.slice(0, 4);
    let visitCount = 0;
    let invoiceCount = 0;

    interface VisitOpts {
      day: string;
      doctor: (typeof doctors)[number];
      patientId: string;
      checkedIn: Date;
      stage: "waiting" | "in_consultation" | "completed" | "cancelled";
      bill: boolean;
      dispense: boolean;
      /** For today's completed visits: leave the prescription waiting at the counter. */
      leaveAtCounter?: boolean;
    }

    async function visit(o: VisitOpts): Promise<void> {
      const key = `${o.doctor.doctor_id}|${o.day}`;
      const token = (tokenCounters.get(key) ?? 0) + 1;
      tokenCounters.set(key, token);
      const visitId = newId("VIS");
      const correlation = newCorrelationId();
      const dept = o.doctor.department_id;
      const pattern = pick(PATTERNS[dept] ?? PATTERNS.general_medicine!);

      const waitMin = between(4, 38);
      const consultMin = between(8, 22);
      const started = new Date(o.checkedIn.getTime() + waitMin * 60_000);
      const done = new Date(started.getTime() + consultMin * 60_000);
      const status = o.stage;

      await c.query(
        `INSERT INTO visits (visit_id, patient_id, department_id, doctor_id, visit_date, token_number, source, status, priority, reason,
                             checked_in_at, consult_started_at, completed_at, cancelled_at, cancel_reason, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'normal', $9, $10, $11, $12, $13, $14, $15)`,
        [
          visitId, o.patientId, dept, o.doctor.doctor_id, o.day, token, chance(0.35) ? "appointment" : "walk_in", status, pattern.complaint,
          o.checkedIn,
          status === "waiting" || status === "cancelled" ? null : started,
          status === "completed" ? done : null,
          status === "cancelled" ? new Date(o.checkedIn.getTime() + 20 * 60_000) : null,
          status === "cancelled" ? "Left before consultation" : null,
          correlation,
        ],
      );
      await c.query(
        `INSERT INTO visit_tokens (doctor_id, visit_date, last_token) VALUES ($1, $2, $3)
         ON CONFLICT (doctor_id, visit_date) DO UPDATE SET last_token = GREATEST(visit_tokens.last_token, $3)`,
        [o.doctor.doctor_id, o.day, token],
      );
      visitCount += 1;
      if (status === "cancelled") return;

      // Vitals, taken by the nurse while waiting.
      const sys = between(104, 168);
      await c.query(
        `INSERT INTO vitals (vital_id, visit_id, patient_id, recorded_by, recorded_at, bp_systolic, bp_diastolic, pulse, temperature_c, spo2,
                             weight_kg, height_cm)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          newId("VIT"), visitId, o.patientId, AUTHOR, new Date(o.checkedIn.getTime() + 3 * 60_000), sys, Math.min(sys - 20, between(64, 100)),
          between(62, 104), (36.2 + rand() * 2.1).toFixed(1), between(94, 99), (48 + rand() * 40).toFixed(1), (150 + rand() * 32).toFixed(1),
        ],
      );
      if (status !== "completed") return;

      const consultationId = newId("CON");
      await c.query(
        `INSERT INTO consultations (consultation_id, visit_id, patient_id, doctor_id, written_by, chief_complaint, history, examination,
                                    diagnosis, advice, status, finalised_at, correlation_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'final', $11, $12, $13, $11)`,
        [
          consultationId, visitId, o.patientId, o.doctor.doctor_id, AUTHOR, pattern.complaint, null, null, pattern.diagnosis, pattern.advice,
          done, correlation, started,
        ],
      );

      // Skip anything the patient is allergic to: demo history should not contradict the safety net.
      const allergic = (await c.query<{ allergies: string | null }>(`SELECT allergies FROM patients WHERE patient_id = $1`, [o.patientId])).rows[0]?.allergies;
      const items = pattern.items.filter((i) => !(allergic && /penicillin/i.test(allergic) && /amoxicillin|clavulan/i.test(i.name)));
      const known = items.filter((i) => meds.has(i.name));
      if (known.length === 0) return;

      const prescriptionId = newId("RX");
      const atCounter = o.leaveAtCounter === true;
      const dispenseIt = o.dispense && !atCounter;
      await c.query(
        `INSERT INTO prescriptions (prescription_id, consultation_id, visit_id, patient_id, doctor_id, status, issued_at, correlation_id, pharmacy_note, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $7, $7)`,
        [
          prescriptionId, consultationId, visitId, o.patientId, o.doctor.doctor_id,
          // A past prescription nobody collected was closed by the pharmacy, not left waiting for days.
          dispenseIt ? "dispensed" : atCounter ? "issued" : "cancelled",
          done, correlation, dispenseIt || atCounter ? null : "Patient bought the medicines elsewhere",
        ],
      );

      const lines: { description: string; qty: number; price: number; ref: string }[] = [];
      const dispensationId = dispenseIt ? newId("DSP") : null;
      let dispensedTotal = 0;
      if (dispensationId) {
        await c.query(
          `INSERT INTO dispensations (dispensation_id, prescription_id, patient_id, dispensed_by, dispensed_at, total_amount, correlation_id)
           VALUES ($1, $2, $3, $4, $5, 0, $6)`,
          [dispensationId, prescriptionId, o.patientId, AUTHOR, new Date(done.getTime() + between(6, 25) * 60_000), correlation],
        );
      }

      for (const [idx, it] of known.entries()) {
        const medicineId = meds.get(it.name)!;
        const qty = quantityFor({ doseUnits: it.dose, frequency: it.freq, durationDays: it.days });
        const itemId = newId("RXI");
        await c.query(
          `INSERT INTO prescription_items (item_id, prescription_id, position, medicine_id, medicine_name, dose_units, frequency, duration_days,
                                           timing, quantity, dispensed_qty)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [itemId, prescriptionId, idx + 1, medicineId, it.name, it.dose, it.freq, it.days, it.timing, qty, dispensationId ? qty : 0],
        );
        if (!dispensationId) continue;

        const batch = await batchFor(medicineId);
        if (!batch || batch.quantity_on_hand < qty) continue;
        const price = Number(batch.unit_price);
        const lineTotal = Math.round(qty * price * 100) / 100;
        dispensedTotal += lineTotal;
        const dsiId = newId("DSI");
        await c.query(`UPDATE medicine_batches SET quantity_on_hand = quantity_on_hand - $2 WHERE batch_id = $1`, [batch.batch_id, qty]);
        await c.query(
          `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference, created_at)
           VALUES ($1, $2, 'dispense', $3, $4, $5)`,
          [medicineId, batch.batch_id, -qty, dispensationId, new Date(done.getTime() + 10 * 60_000)],
        );
        await c.query(
          `INSERT INTO dispensation_items (dispensation_item_id, dispensation_id, prescription_item_id, medicine_id, batch_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [dsiId, dispensationId, itemId, medicineId, batch.batch_id, qty, price, lineTotal],
        );
        lines.push({ description: it.name, qty, price, ref: `dsi:${dsiId}` });
      }
      if (dispensationId) {
        await c.query(`UPDATE dispensations SET total_amount = $2 WHERE dispensation_id = $1`, [dispensationId, Math.round(dispensedTotal * 100) / 100]);
      }

      if (!o.bill) return;

      // Invoice: the consultation fee, then the medicines, then payment.
      const fee = Number(o.doctor.fee);
      const invoiceId = newId("INV");
      const number = `INV-${year}-${String((await c.query<{ n: number }>(`SELECT nextval('invoice_seq')::int AS n`)).rows[0]!.n).padStart(6, "0")}`;
      const subtotal = Math.round((fee + lines.reduce((n, l) => n + l.qty * l.price, 0)) * 100) / 100;
      const discount = chance(0.06) ? Math.round(subtotal * 0.05 * 100) / 100 : 0;
      const total = Math.round((subtotal - discount) * 100) / 100;
      const issuedAt = new Date(done.getTime() + between(12, 40) * 60_000);
      const outcome = chance(0.86) ? "paid" : chance(0.6) ? "partial" : "unpaid";
      const paid = outcome === "paid" ? total : outcome === "partial" ? Math.round(total * 0.5 * 100) / 100 : 0;
      const invStatus = outcome === "paid" ? "paid" : outcome === "partial" ? "partially_paid" : "issued";

      await c.query(
        `INSERT INTO invoices (invoice_id, invoice_number, patient_id, visit_id, status, subtotal, discount_amount, discount_reason, tax_amount,
                               total, amount_paid, due_date, created_by, issued_by, issued_at, correlation_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $12, $13, $14, $13, $13)`,
        [
          invoiceId, number, o.patientId, visitId, invStatus, subtotal, discount, discount ? "Senior citizen" : null, total, paid,
          addDays(o.day, 7), AUTHOR, issuedAt, correlation,
        ],
      );
      let pos = 1;
      await c.query(
        `INSERT INTO invoice_lines (line_id, invoice_id, position, kind, description, quantity, unit_price, line_total, source_ref)
         VALUES ($1, $2, $3, 'consultation', $4, 1, $5, $5, $6)`,
        [newId("LIN"), invoiceId, pos++, `Consultation: ${o.doctor.full_name}`, fee, `visit-fee:${visitId}`],
      );
      for (const l of lines) {
        await c.query(
          `INSERT INTO invoice_lines (line_id, invoice_id, position, kind, description, quantity, unit_price, line_total, source_ref)
           VALUES ($1, $2, $3, 'pharmacy', $4, $5, $6, $7, $8)`,
          [newId("LIN"), invoiceId, pos++, l.description, l.qty, l.price, Math.round(l.qty * l.price * 100) / 100, l.ref],
        );
      }
      invoiceCount += 1;

      if (paid > 0) {
        const receipt = `RCT-${year}-${String((await c.query<{ n: number }>(`SELECT nextval('receipt_seq')::int AS n`)).rows[0]!.n).padStart(6, "0")}`;
        await c.query(
          `INSERT INTO payments (payment_id, invoice_id, kind, amount, method, receipt_number, received_by, received_at)
           VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7)`,
          [newId("PAY"), invoiceId, paid, weighted(METHODS), receipt, AUTHOR, new Date(issuedAt.getTime() + between(1, 12) * 60_000)],
        );
      }
    }

    // --- the past: weekday OPD sessions ------------------------------------------------------------
    for (let i = days; i >= 1; i--) {
      const day = addDays(today, -i);
      const weekday = new Date(`${day}T12:00:00+05:30`).getUTCDay();
      if (weekday === 0) continue;
      const perDay = between(9, 17) + (weekday === 6 ? 3 : 0);
      for (let n = 0; n < perDay; n++) {
        const doctor = pick(doctors);
        const minutes = between(0, 7 * 60 + 30);
        await visit({
          day,
          doctor,
          patientId: pick(patientIds),
          checkedIn: new Date(istAt(day, 9, 0).getTime() + minutes * 60_000),
          stage: chance(0.05) ? "cancelled" : "completed",
          bill: true,
          dispense: chance(0.88),
        });
      }
    }

    // --- today: a live-looking morning ---------------------------------------------------------------
    const now = new Date();
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    const live: Omit<VisitOpts, "day" | "doctor" | "patientId">[] = [
      { checkedIn: ago(95), stage: "completed", bill: false, dispense: true, leaveAtCounter: true },
      { checkedIn: ago(80), stage: "completed", bill: false, dispense: true, leaveAtCounter: true },
      { checkedIn: ago(70), stage: "completed", bill: false, dispense: true },
      { checkedIn: ago(46), stage: "in_consultation", bill: false, dispense: false },
      { checkedIn: ago(31), stage: "waiting", bill: false, dispense: false },
      { checkedIn: ago(22), stage: "waiting", bill: false, dispense: false },
      { checkedIn: ago(9), stage: "waiting", bill: false, dispense: false },
    ];
    const cardio = doctors.filter((d) => d.department_id === "cardiology");
    // Distinct people, so nobody is in the same doctor's queue twice.
    const todays = [...patientIds].sort(() => rand() - 0.5).slice(0, live.length);
    for (const [i, v] of live.entries()) {
      await visit({ ...v, day: today, doctor: cardio[i % cardio.length] ?? doctors[0]!, patientId: todays[i]! });
    }

    // --- inpatients ---------------------------------------------------------------------------------
    const wards = (await c.query<{ ward_id: string; daily_rate: string }>(`SELECT ward_id, daily_rate::text FROM wards WHERE active ORDER BY ward_id`)).rows;
    const beds = (await c.query<{ bed_id: string; ward_id: string }>(`SELECT bed_id, ward_id FROM beds WHERE active ORDER BY bed_id`)).rows;
    const rate = new Map(wards.map((w) => [w.ward_id, Number(w.daily_rate)]));
    const taken = new Set<string>();
    const patientsFree = [...patientIds];
    const takePatient = () => patientsFree.splice(Math.floor(rand() * patientsFree.length), 1)[0]!;
    const reasons = ["Chest pain, observation", "Post-operative care", "Severe dehydration, IV fluids", "Fracture, traction", "Uncontrolled blood sugar", "Pneumonia"];

    async function admission(opts: { bedId: string; daysAgo: number; stayDaysTotal: number | null }) {
      const bed = beds.find((b) => b.bed_id === opts.bedId)!;
      const doctor = pick(doctors);
      const patientId = takePatient();
      const admittedAt = new Date(istAt(addDays(today, -opts.daysAgo), 10, between(0, 50)));
      const dischargedAt = opts.stayDaysTotal === null ? null : new Date(admittedAt.getTime() + opts.stayDaysTotal * 86_400_000 + 3 * 3_600_000);
      const admissionId = newId("ADM");
      const correlation = newCorrelationId();
      await c.query(
        `INSERT INTO admissions (admission_id, patient_id, doctor_id, department_id, status, reason, admitted_at, discharged_at, admitted_by, discharged_by, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [admissionId, patientId, doctor.doctor_id, doctor.department_id, dischargedAt ? "discharged" : "admitted", pick(reasons), admittedAt, dischargedAt, AUTHOR, dischargedAt ? AUTHOR : null, correlation],
      );
      const stayId = newId("STY");
      await c.query(
        `INSERT INTO bed_stays (stay_id, admission_id, bed_id, ward_id, daily_rate, started_at, ended_at, ended_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [stayId, admissionId, opts.bedId, bed.ward_id, rate.get(bed.ward_id), admittedAt, dischargedAt, dischargedAt ? "discharge" : null],
      );
      if (!dischargedAt) {
        await c.query(`UPDATE beds SET status = 'occupied' WHERE bed_id = $1`, [opts.bedId]);
        return;
      }

      // Bill the stay: bed charges, with most paid.
      const nDays = stayDays({ startedAt: admittedAt, endedAt: dischargedAt, endedReason: "discharge" });
      const price = rate.get(bed.ward_id)!;
      const total = Math.round(nDays * price * 100) / 100;
      const invoiceId = newId("INV");
      const number = `INV-${year}-${String((await c.query<{ n: number }>(`SELECT nextval('invoice_seq')::int AS n`)).rows[0]!.n).padStart(6, "0")}`;
      const paid = chance(0.75) ? total : 0;
      await c.query(
        `INSERT INTO invoices (invoice_id, invoice_number, patient_id, admission_id, status, subtotal, total, amount_paid, due_date, created_by,
                               issued_by, issued_at, correlation_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $9, $10, $11, $10, $10)`,
        [invoiceId, number, patientId, admissionId, paid > 0 ? "paid" : "issued", total, paid, addDays(istDateString(dischargedAt), 7), AUTHOR, dischargedAt, correlation],
      );
      await c.query(
        `INSERT INTO invoice_lines (line_id, invoice_id, position, kind, description, quantity, unit_price, line_total, source_ref)
         VALUES ($1, $2, 1, 'bed', $3, $4, $5, $6, $7)`,
        [newId("LIN"), invoiceId, `Bed ${opts.bedId.replace("BED-", "")}`, nDays, price, total, `stay:${stayId}`],
      );
      invoiceCount += 1;
      if (paid > 0) {
        const receipt = `RCT-${year}-${String((await c.query<{ n: number }>(`SELECT nextval('receipt_seq')::int AS n`)).rows[0]!.n).padStart(6, "0")}`;
        await c.query(
          `INSERT INTO payments (payment_id, invoice_id, kind, amount, method, receipt_number, received_by, received_at)
           VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7)`,
          [newId("PAY"), invoiceId, paid, weighted(METHODS), receipt, AUTHOR, new Date(dischargedAt.getTime() + 20 * 60_000)],
        );
      }
    }

    const freeBed = (wardId?: string) => {
      const b = beds.find((x) => !taken.has(x.bed_id) && (!wardId || x.ward_id === wardId))!;
      taken.add(b.bed_id);
      return b.bed_id;
    };
    // Past stays leave their beds free (they were discharged); only today's inpatients hold beds.
    for (const stay of [3, 2, 5, 4, 2, 6]) {
      await admission({ bedId: pick(beds).bed_id, daysAgo: between(stay + 2, days - 1), stayDaysTotal: stay });
    }
    await admission({ bedId: freeBed("WRD-GEN"), daysAgo: 4, stayDaysTotal: null });
    await admission({ bedId: freeBed("WRD-GEN"), daysAgo: 2, stayDaysTotal: null });
    await admission({ bedId: freeBed("WRD-SEM"), daysAgo: 1, stayDaysTotal: null });
    await admission({ bedId: freeBed("WRD-PVT"), daysAgo: 3, stayDaysTotal: null });
    await admission({ bedId: freeBed("WRD-ICU"), daysAgo: 1, stayDaysTotal: null });
    // A bed being cleaned and one under maintenance, so the board shows every state.
    await c.query(`UPDATE beds SET status = 'cleaning' WHERE bed_id = $1`, [freeBed("WRD-GEN")]);
    await c.query(`UPDATE beds SET status = 'maintenance' WHERE bed_id = $1`, [freeBed("WRD-SEM")]);

    // --- pharmacy talking points: something low, something expiring, something expired ----------------
    const lowId = meds.get("Atorvastatin 20 mg");
    if (lowId) {
      await c.query(`UPDATE medicines SET reorder_level = 5000 WHERE medicine_id = $1`, [lowId]);
    }
    const soonId = meds.get("Paracetamol 650 mg");
    const expiredId = meds.get("Cetirizine 10 mg");
    for (const [medId, label, offset, qty] of [
      [soonId, "EXP-SOON", 24, 60],
      [expiredId, "EXP-OLD", -6, 40],
    ] as const) {
      if (!medId) continue;
      const batchId = `BAT-${medId}-${label}`;
      await c.query(
        `INSERT INTO medicine_batches (batch_id, medicine_id, batch_number, expiry_date, quantity_received, quantity_on_hand, unit_cost, unit_price, supplier)
         VALUES ($1, $2, $3, $4::date + $5::int, $6, $6, 1, 2, 'Demo Distributors') ON CONFLICT DO NOTHING`,
        [batchId, medId, label, today, offset, qty],
      );
      await c.query(
        `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference)
         SELECT $1, $2, 'receipt', $3, 'older delivery' WHERE NOT EXISTS (SELECT 1 FROM stock_movements WHERE batch_id = $2)`,
        [medId, batchId, qty],
      );
    }

    await c.query("COMMIT");
    console.log(`clinical history: ${visitCount} visits, ${invoiceCount} invoices over ${days} days, 5 current inpatients`);
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (process.argv[1]?.endsWith("demo-clinic.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  generateClinicHistory(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
