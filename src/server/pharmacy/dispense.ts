import { audit } from "@/lib/audit";
import { many, one, tx, type Db } from "@/lib/db";
import { newId } from "@/lib/ids";
import type { Frequency, Timing } from "@/lib/prescribing";
import { can } from "@/lib/rbac";
import { istDateString } from "@/lib/time";
import type { Actor } from "@/server/clinic/consultation";
import { PharmacyError } from "./stock";

function requireDispense(actor: Actor): void {
  if (!can(actor.role, "pharmacy.dispense")) throw new PharmacyError("forbidden", "Only the pharmacy can dispense medicines.");
}

export interface PharmacyQueueRow {
  prescription_id: string;
  status: "issued" | "partially_dispensed";
  issued_at: Date;
  patient_id: string;
  patient_name: string;
  uhid: string;
  date_of_birth: string | null;
  dob_estimated: boolean;
  allergies: string | null;
  allergy_override_reason: string | null;
  doctor_name: string;
  department: string;
  items: number;
  outstanding: number;
}

/** Prescriptions waiting at the counter, oldest first: the order patients arrived at the pharmacy. */
export async function pharmacyQueue(db: Db): Promise<PharmacyQueueRow[]> {
  return many<PharmacyQueueRow>(
    db,
    `SELECT rx.prescription_id, rx.status, rx.issued_at, p.patient_id, p.full_name AS patient_name, p.uhid, p.date_of_birth,
            p.dob_estimated, p.allergies, rx.allergy_override_reason, d.full_name AS doctor_name, dep.name AS department,
            count(i.item_id)::int AS items,
            count(i.item_id) FILTER (WHERE i.dispensed_qty < i.quantity)::int AS outstanding
       FROM prescriptions rx
       JOIN patients p ON p.patient_id = rx.patient_id
       JOIN doctors d ON d.doctor_id = rx.doctor_id
       JOIN departments dep ON dep.department_id = d.department_id
       JOIN prescription_items i ON i.prescription_id = rx.prescription_id
      WHERE rx.status IN ('issued', 'partially_dispensed')
      GROUP BY rx.prescription_id, p.patient_id, d.doctor_id, dep.department_id
      ORDER BY rx.issued_at`,
  );
}

export interface PharmacyItem {
  item_id: string;
  position: number;
  medicine_id: string | null;
  medicine_name: string;
  generic_name: string | null;
  form: string | null;
  unit: string | null;
  dose_units: number;
  frequency: Frequency;
  duration_days: number;
  timing: Timing;
  quantity: number;
  dispensed_qty: number;
  instructions: string | null;
  /** Units dispensable right now: in stock and not expired. */
  available: number;
  /** Price per unit of the batch that would be used first. */
  unit_price: number | null;
  next_expiry: string | null;
}

export interface PharmacyPrescription {
  prescription_id: string;
  status: string;
  issued_at: Date | null;
  patient_id: string;
  patient_name: string;
  uhid: string;
  date_of_birth: string | null;
  dob_estimated: boolean;
  gender: string | null;
  allergies: string | null;
  allergy_override_reason: string | null;
  doctor_name: string;
  department: string;
  diagnosis: string | null;
  pharmacy_note: string | null;
  items: PharmacyItem[];
  dispensations: { dispensation_id: string; dispensed_at: Date; by: string; total: number }[];
}

export async function getPrescription(db: Db, prescriptionId: string): Promise<PharmacyPrescription | null> {
  const head = await one<Omit<PharmacyPrescription, "items" | "dispensations">>(
    db,
    `SELECT rx.prescription_id, rx.status, rx.issued_at, p.patient_id, p.full_name AS patient_name, p.uhid, p.date_of_birth,
            p.dob_estimated, p.gender, p.allergies, rx.allergy_override_reason, d.full_name AS doctor_name,
            dep.name AS department, c.diagnosis, rx.pharmacy_note
       FROM prescriptions rx
       JOIN patients p ON p.patient_id = rx.patient_id
       JOIN doctors d ON d.doctor_id = rx.doctor_id
       JOIN departments dep ON dep.department_id = d.department_id
       JOIN consultations c ON c.consultation_id = rx.consultation_id
      WHERE rx.prescription_id = $1`,
    [prescriptionId],
  );
  if (!head) return null;

  const today = istDateString();
  const items = await many<PharmacyItem>(
    db,
    `SELECT i.item_id, i.position, i.medicine_id, i.medicine_name, m.generic_name, m.form, m.unit,
            i.dose_units::float AS dose_units, i.frequency, i.duration_days, i.timing, i.quantity, i.dispensed_qty, i.instructions,
            COALESCE((SELECT sum(b.quantity_on_hand) FROM medicine_batches b
                       WHERE b.medicine_id = i.medicine_id AND b.expiry_date >= $2), 0)::int AS available,
            (SELECT b.unit_price::float FROM medicine_batches b
              WHERE b.medicine_id = i.medicine_id AND b.quantity_on_hand > 0 AND b.expiry_date >= $2
              ORDER BY b.expiry_date, b.batch_id LIMIT 1) AS unit_price,
            (SELECT b.expiry_date FROM medicine_batches b
              WHERE b.medicine_id = i.medicine_id AND b.quantity_on_hand > 0 AND b.expiry_date >= $2
              ORDER BY b.expiry_date, b.batch_id LIMIT 1) AS next_expiry
       FROM prescription_items i LEFT JOIN medicines m ON m.medicine_id = i.medicine_id
      WHERE i.prescription_id = $1 ORDER BY i.position`,
    [prescriptionId, today],
  );
  const dispensations = await many<{ dispensation_id: string; dispensed_at: Date; by: string; total: number }>(
    db,
    `SELECT x.dispensation_id, x.dispensed_at, u.full_name AS by, x.total_amount::float AS total
       FROM dispensations x JOIN staff_users u ON u.user_id = x.dispensed_by
      WHERE x.prescription_id = $1 ORDER BY x.dispensed_at`,
    [prescriptionId],
  );
  return { ...head, items, dispensations };
}

export interface DispenseLine {
  itemId: string;
  quantity: number;
}

export interface DispenseResult {
  dispensationId: string;
  total: number;
  prescriptionStatus: "partially_dispensed" | "dispensed";
}

/**
 * Hands medicines over: takes stock first-expired-first-out, records every unit in the
 * movement ledger, prices the lines at the batch actually used, and moves the prescription
 * to partially_dispensed or dispensed.
 *
 * All or nothing for the lines submitted. Locks are taken in a fixed order (prescription,
 * then batches by medicine and expiry) so two counters cannot deadlock or both take the last units.
 */
export async function dispensePrescription(actor: Actor, prescriptionId: string, lines: DispenseLine[]): Promise<DispenseResult> {
  requireDispense(actor);

  const wanted = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 0) throw new PharmacyError("validation", "Quantities must be whole numbers.");
    if (l.quantity > 0) wanted.set(l.itemId, (wanted.get(l.itemId) ?? 0) + l.quantity);
  }
  if (wanted.size === 0) throw new PharmacyError("nothing_to_dispense", "Enter a quantity to dispense.");

  return tx(async (c) => {
    const rx = await one<{ status: string; patient_id: string; correlation_id: string }>(
      c,
      `SELECT status, patient_id, correlation_id FROM prescriptions WHERE prescription_id = $1 FOR UPDATE`,
      [prescriptionId],
    );
    if (!rx) throw new PharmacyError("prescription_not_found", "That prescription does not exist.");
    if (rx.status !== "issued" && rx.status !== "partially_dispensed") {
      throw new PharmacyError("wrong_state", `This prescription is ${rx.status.replace("_", " ")}.`);
    }

    const items = await many<{ item_id: string; medicine_id: string | null; medicine_name: string; quantity: number; dispensed_qty: number }>(
      c,
      `SELECT item_id, medicine_id, medicine_name, quantity, dispensed_qty FROM prescription_items WHERE prescription_id = $1 FOR UPDATE`,
      [prescriptionId],
    );
    const byId = new Map(items.map((i) => [i.item_id, i]));

    for (const [itemId, qty] of wanted) {
      const item = byId.get(itemId);
      if (!item) throw new PharmacyError("item_not_found", "That item is not on this prescription.");
      if (!item.medicine_id) {
        throw new PharmacyError("not_linked", `Match "${item.medicine_name}" to a formulary medicine before dispensing it.`, { item_id: itemId });
      }
      const outstanding = item.quantity - item.dispensed_qty;
      if (qty > outstanding) {
        throw new PharmacyError("over_dispense", `${item.medicine_name}: only ${outstanding} still to dispense.`, { item_id: itemId, outstanding });
      }
    }

    const dispensationId = newId("DSP");
    await c.query(
      `INSERT INTO dispensations (dispensation_id, prescription_id, patient_id, dispensed_by, correlation_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [dispensationId, prescriptionId, rx.patient_id, actor.user_id, rx.correlation_id],
    );

    const today = istDateString();
    let total = 0;
    // Medicine order first, so every transaction locks batches in the same global order.
    const ordered = [...wanted.entries()].sort(([a], [b]) => (byId.get(a)!.medicine_id! < byId.get(b)!.medicine_id! ? -1 : 1));

    for (const [itemId, qty] of ordered) {
      const item = byId.get(itemId)!;
      const batches = await many<{ batch_id: string; quantity_on_hand: number; unit_price: number }>(
        c,
        `SELECT batch_id, quantity_on_hand, unit_price::float AS unit_price
           FROM medicine_batches
          WHERE medicine_id = $1 AND quantity_on_hand > 0 AND expiry_date >= $2
          ORDER BY expiry_date, batch_id
            FOR UPDATE`,
        [item.medicine_id, today],
      );
      const available = batches.reduce((n, b) => n + b.quantity_on_hand, 0);
      if (available < qty) {
        throw new PharmacyError("insufficient_stock", `${item.medicine_name}: ${available} in stock, ${qty} needed.`, {
          item_id: itemId,
          available,
          requested: qty,
        });
      }

      let remaining = qty;
      for (const b of batches) {
        if (remaining === 0) break;
        const take = Math.min(remaining, b.quantity_on_hand);
        remaining -= take;
        const lineTotal = Math.round(take * b.unit_price * 100) / 100;
        total += lineTotal;
        await c.query(`UPDATE medicine_batches SET quantity_on_hand = quantity_on_hand - $2 WHERE batch_id = $1`, [b.batch_id, take]);
        await c.query(
          `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference, actor_id)
           VALUES ($1, $2, 'dispense', $3, $4, $5)`,
          [item.medicine_id, b.batch_id, -take, dispensationId, actor.user_id],
        );
        await c.query(
          `INSERT INTO dispensation_items (dispensation_item_id, dispensation_id, prescription_item_id, medicine_id, batch_id,
                                           quantity, unit_price, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newId("DSI"), dispensationId, itemId, item.medicine_id, b.batch_id, take, b.unit_price, lineTotal],
        );
      }
      await c.query(`UPDATE prescription_items SET dispensed_qty = dispensed_qty + $2 WHERE item_id = $1`, [itemId, qty]);
    }

    total = Math.round(total * 100) / 100;
    await c.query(`UPDATE dispensations SET total_amount = $2 WHERE dispensation_id = $1`, [dispensationId, total]);

    const left = await one<{ n: number }>(
      c,
      `SELECT count(*)::int AS n FROM prescription_items WHERE prescription_id = $1 AND dispensed_qty < quantity`,
      [prescriptionId],
    );
    const status = left!.n === 0 ? "dispensed" : "partially_dispensed";
    await c.query(`UPDATE prescriptions SET status = $2, updated_at = now() WHERE prescription_id = $1`, [prescriptionId, status]);

    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "prescription.dispensed",
      recordId: prescriptionId,
      correlationId: rx.correlation_id,
      details: { dispensation_id: dispensationId, total, status, lines: wanted.size },
    });
    return { dispensationId, total, prescriptionStatus: status };
  });
}

export interface Alternative {
  medicine_id: string;
  name: string;
  available: number;
  unit_price: number | null;
}

/** Other brands of the same generic that are in stock now: safe to hand over in place of the one prescribed. */
export async function alternativesFor(db: Db, medicineId: string): Promise<Alternative[]> {
  return many<Alternative>(
    db,
    `SELECT m.medicine_id, m.name,
            COALESCE(sum(b.quantity_on_hand), 0)::int AS available,
            (SELECT x.unit_price::float FROM medicine_batches x WHERE x.medicine_id = m.medicine_id AND x.quantity_on_hand > 0 AND x.expiry_date >= $2
              ORDER BY x.expiry_date, x.batch_id LIMIT 1) AS unit_price
       FROM medicines m
       JOIN medicines orig ON orig.medicine_id = $1 AND lower(orig.generic_name) = lower(m.generic_name) AND orig.form = m.form
       JOIN medicine_batches b ON b.medicine_id = m.medicine_id AND b.quantity_on_hand > 0 AND b.expiry_date >= $2
      WHERE m.active AND m.medicine_id <> $1
      GROUP BY m.medicine_id, m.name
      ORDER BY available DESC, m.name
      LIMIT 4`,
    [medicineId, istDateString()],
  );
}

/** Swaps a prescribed item for another brand of the same generic and form. Recorded against the pharmacist. */
export async function substituteItem(actor: Actor, itemId: string, medicineId: string): Promise<void> {
  requireDispense(actor);
  await tx(async (c) => {
    const item = await one<{ status: string; medicine_id: string | null; dispensed_qty: number }>(
      c,
      `SELECT rx.status, i.medicine_id, i.dispensed_qty FROM prescription_items i JOIN prescriptions rx ON rx.prescription_id = i.prescription_id
        WHERE i.item_id = $1 FOR UPDATE OF i`,
      [itemId],
    );
    if (!item) throw new PharmacyError("item_not_found", "That item does not exist.");
    if (item.status !== "issued" && item.status !== "partially_dispensed") throw new PharmacyError("wrong_state", "This prescription is closed.");
    if (!item.medicine_id || item.dispensed_qty > 0) throw new PharmacyError("wrong_state", "This item cannot be swapped.");
    const same = await one(
      c,
      `SELECT 1 FROM medicines a JOIN medicines b ON lower(a.generic_name) = lower(b.generic_name) AND a.form = b.form
        WHERE a.medicine_id = $1 AND b.medicine_id = $2 AND b.active`,
      [item.medicine_id, medicineId],
    );
    if (!same) throw new PharmacyError("medicine_not_found", "Only another brand of the same medicine can be used in its place.");
    await c.query(`UPDATE prescription_items SET medicine_id = $2 WHERE item_id = $1`, [itemId, medicineId]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "prescription.item_substituted", recordId: itemId, details: { from: item.medicine_id, to: medicineId } });
  });
}

/** The doctor wrote a name the formulary does not know; the pharmacist says which product it is. */
export async function linkItemToMedicine(actor: Actor, itemId: string, medicineId: string): Promise<void> {
  requireDispense(actor);
  await tx(async (c) => {
    const item = await one<{ status: string }>(
      c,
      `SELECT rx.status FROM prescription_items i JOIN prescriptions rx ON rx.prescription_id = i.prescription_id
        WHERE i.item_id = $1 FOR UPDATE OF i`,
      [itemId],
    );
    if (!item) throw new PharmacyError("item_not_found", "That item does not exist.");
    if (item.status !== "issued" && item.status !== "partially_dispensed") throw new PharmacyError("wrong_state", "This prescription is closed.");
    const med = await one(c, `SELECT 1 FROM medicines WHERE medicine_id = $1 AND active`, [medicineId]);
    if (!med) throw new PharmacyError("medicine_not_found", "That medicine is not in the formulary.");
    await c.query(`UPDATE prescription_items SET medicine_id = $2 WHERE item_id = $1`, [itemId, medicineId]);
    await audit(c, { workflow: "clinic", actor: "staff", action: "prescription.item_linked", recordId: itemId, details: { medicine_id: medicineId } });
  });
}

/**
 * Closes a prescription with items not supplied (out of stock, patient declined). It leaves
 * the queue, and the reason stays on the record.
 */
export async function closePrescription(actor: Actor, prescriptionId: string, note: string): Promise<void> {
  requireDispense(actor);
  const text = note.trim();
  if (text.length < 3) throw new PharmacyError("validation", "Say why this is being closed.");
  await tx(async (c) => {
    const rx = await one<{ status: string; correlation_id: string; dispensed: number }>(
      c,
      `SELECT rx.status, rx.correlation_id,
              COALESCE((SELECT sum(dispensed_qty) FROM prescription_items WHERE prescription_id = rx.prescription_id), 0)::int AS dispensed
         FROM prescriptions rx WHERE rx.prescription_id = $1 FOR UPDATE`,
      [prescriptionId],
    );
    if (!rx) throw new PharmacyError("prescription_not_found", "That prescription does not exist.");
    if (rx.status !== "issued" && rx.status !== "partially_dispensed") throw new PharmacyError("wrong_state", "This prescription is already closed.");
    // Nothing handed over means it was declined or could not be filled at all.
    const status = rx.dispensed > 0 ? "dispensed" : "cancelled";
    await c.query(`UPDATE prescriptions SET status = $2, pharmacy_note = $3, updated_at = now() WHERE prescription_id = $1`, [
      prescriptionId,
      status,
      text.slice(0, 300),
    ]);
    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "prescription.closed",
      recordId: prescriptionId,
      correlationId: rx.correlation_id,
      details: { status, note: text },
    });
  });
}
