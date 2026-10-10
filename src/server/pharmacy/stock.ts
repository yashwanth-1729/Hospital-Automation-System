import { z } from "zod";
import { audit } from "@/lib/audit";
import { many, one, tx, type Db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { can } from "@/lib/rbac";
import { addDays, isValidDateString, istDateString } from "@/lib/time";
import type { Actor } from "@/server/clinic/consultation";

export type PharmacyErrorCode =
  | "forbidden"
  | "medicine_not_found"
  | "batch_not_found"
  | "prescription_not_found"
  | "item_not_found"
  | "wrong_state"
  | "insufficient_stock"
  | "over_dispense"
  | "not_linked"
  | "nothing_to_dispense"
  | "validation";

export class PharmacyError extends Error {
  constructor(
    public readonly code: PharmacyErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function requireStock(actor: Actor): void {
  if (!can(actor.role, "pharmacy.stock")) throw new PharmacyError("forbidden", "Your role cannot change stock.");
}

/** Days before expiry at which a batch is flagged. */
export const EXPIRY_WARNING_DAYS = 60;

const money = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number({ error: "Enter an amount." }).min(0, "Cannot be negative.").max(1_000_000),
);

const ReceiptSchema = z.object({
  medicine_id: z.string().min(1, "Choose a medicine."),
  batch_number: z.string().trim().min(1, "Enter the batch number.").max(40),
  expiry_date: z
    .string()
    .trim()
    .refine(isValidDateString, "Enter the expiry date.")
    .refine((d) => d >= istDateString(), "That batch has already expired."),
  quantity: z.preprocess(
    (v) => (v === "" ? undefined : Number(v)),
    z.number({ error: "Enter the quantity." }).int("Whole units only.").min(1, "At least 1.").max(1_000_000),
  ),
  unit_cost: money.optional().default(0),
  unit_price: money,
  supplier: z.string().trim().max(120).optional(),
});
export type ReceiptInput = z.input<typeof ReceiptSchema>;

export async function receiveStock(
  actor: Actor,
  raw: ReceiptInput,
): Promise<{ ok: true; batchId: string; toppedUp: boolean } | { ok: false; errors: Record<string, string> }> {
  requireStock(actor);
  const parsed = ReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const i of parsed.error.issues) errors[String(i.path[0] ?? "_")] ??= i.message;
    return { ok: false, errors };
  }
  const v = parsed.data;

  return tx(async (c) => {
    const med = await one(c, `SELECT 1 FROM medicines WHERE medicine_id = $1`, [v.medicine_id]);
    if (!med) throw new PharmacyError("medicine_not_found", "That medicine is not in the formulary.");

    // The same batch delivered again adds to it, provided it is the same product with the same expiry.
    const existing = await one<{ batch_id: string; expiry_date: string }>(
      c,
      `SELECT batch_id, expiry_date FROM medicine_batches WHERE medicine_id = $1 AND batch_number = $2 FOR UPDATE`,
      [v.medicine_id, v.batch_number],
    );
    if (existing && existing.expiry_date !== v.expiry_date) {
      return { ok: false as const, errors: { batch_number: `Batch ${v.batch_number} is already on file with expiry ${existing.expiry_date}.` } };
    }

    let batchId: string;
    if (existing) {
      batchId = existing.batch_id;
      await c.query(
        `UPDATE medicine_batches
            SET quantity_received = quantity_received + $2, quantity_on_hand = quantity_on_hand + $2,
                unit_price = $3, unit_cost = $4
          WHERE batch_id = $1`,
        [batchId, v.quantity, v.unit_price, v.unit_cost],
      );
    } else {
      batchId = newId("BAT");
      await c.query(
        `INSERT INTO medicine_batches (batch_id, medicine_id, batch_number, expiry_date, quantity_received, quantity_on_hand,
                                       unit_cost, unit_price, supplier, received_by)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
        [batchId, v.medicine_id, v.batch_number, v.expiry_date, v.quantity, v.unit_cost, v.unit_price, v.supplier || null, actor.user_id],
      );
    }
    await c.query(
      `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference, actor_id)
       VALUES ($1, $2, 'receipt', $3, $4, $5)`,
      [v.medicine_id, batchId, v.quantity, v.supplier || null, actor.user_id],
    );
    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "stock.received",
      recordId: batchId,
      details: { medicine_id: v.medicine_id, quantity: v.quantity, batch: v.batch_number },
    });
    return { ok: true as const, batchId, toppedUp: !!existing };
  });
}

/**
 * A correction or write-off. Always with a reason, never below zero, and recorded in the
 * ledger like any other movement.
 */
export async function adjustStock(
  actor: Actor,
  opts: { batchId: string; delta: number; reason: string; kind?: "adjustment" | "write_off" },
): Promise<void> {
  requireStock(actor);
  const reason = opts.reason.trim();
  if (!Number.isInteger(opts.delta) || opts.delta === 0) throw new PharmacyError("validation", "Enter a quantity to add or remove.");
  if (reason.length < 3) throw new PharmacyError("validation", "Say why the stock is being changed.");

  await tx(async (c) => {
    const b = await one<{ medicine_id: string; quantity_on_hand: number; quantity_received: number }>(
      c,
      `SELECT medicine_id, quantity_on_hand, quantity_received FROM medicine_batches WHERE batch_id = $1 FOR UPDATE`,
      [opts.batchId],
    );
    if (!b) throw new PharmacyError("batch_not_found", "That batch does not exist.");
    if (b.quantity_on_hand + opts.delta < 0) {
      throw new PharmacyError("insufficient_stock", `Only ${b.quantity_on_hand} in stock for this batch.`);
    }
    // Received count grows with positive corrections so the on-hand <= received rule keeps holding.
    await c.query(
      `UPDATE medicine_batches
          SET quantity_on_hand = quantity_on_hand + $2,
              quantity_received = quantity_received + GREATEST($2, 0)
        WHERE batch_id = $1`,
      [opts.batchId, opts.delta],
    );
    await c.query(
      `INSERT INTO stock_movements (medicine_id, batch_id, kind, quantity, reference, actor_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [b.medicine_id, opts.batchId, opts.kind ?? (opts.delta < 0 ? "write_off" : "adjustment"), opts.delta, reason.slice(0, 200), actor.user_id],
    );
    await audit(c, {
      workflow: "clinic",
      actor: "staff",
      action: "stock.adjusted",
      recordId: opts.batchId,
      details: { delta: opts.delta, reason },
    });
  });
}

export async function setReorderLevel(actor: Actor, medicineId: string, level: number): Promise<void> {
  requireStock(actor);
  if (!Number.isInteger(level) || level < 0 || level > 100000) throw new PharmacyError("validation", "Enter a whole number.");
  const r = await tx((c) => c.query(`UPDATE medicines SET reorder_level = $2 WHERE medicine_id = $1`, [medicineId, level]));
  if (!r.rowCount) throw new PharmacyError("medicine_not_found", "That medicine is not in the formulary.");
}

export interface StockRow {
  medicine_id: string;
  name: string;
  generic_name: string;
  form: string;
  reorder_level: number;
  /** Units that can be dispensed today: in stock and not expired. */
  available: number;
  /** Units on the shelf past their expiry: to be written off. */
  expired: number;
  expiring_soon: number;
  nearest_expiry: string | null;
  batches: number;
  status: "out" | "low" | "ok";
}

export async function stockOverview(db: Db): Promise<StockRow[]> {
  const today = istDateString();
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const rows = await many<Omit<StockRow, "status">>(
    db,
    `SELECT m.medicine_id, m.name, m.generic_name, m.form, m.reorder_level,
            COALESCE(sum(b.quantity_on_hand) FILTER (WHERE b.expiry_date >= $1), 0)::int AS available,
            COALESCE(sum(b.quantity_on_hand) FILTER (WHERE b.expiry_date < $1), 0)::int AS expired,
            COALESCE(sum(b.quantity_on_hand) FILTER (WHERE b.expiry_date >= $1 AND b.expiry_date <= $2), 0)::int AS expiring_soon,
            min(b.expiry_date) FILTER (WHERE b.quantity_on_hand > 0 AND b.expiry_date >= $1) AS nearest_expiry,
            count(b.batch_id) FILTER (WHERE b.quantity_on_hand > 0)::int AS batches
       FROM medicines m LEFT JOIN medicine_batches b ON b.medicine_id = m.medicine_id
      WHERE m.active
      GROUP BY m.medicine_id
      ORDER BY m.name`,
    [today, soon],
  );
  return rows.map((r) => ({
    ...r,
    status: r.available === 0 ? "out" : r.available <= r.reorder_level ? "low" : "ok",
  }));
}

export interface BatchRow {
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  quantity_on_hand: number;
  quantity_received: number;
  unit_price: number;
  supplier: string | null;
  expired: boolean;
}

export async function listBatches(db: Db, medicineId: string): Promise<BatchRow[]> {
  return many<BatchRow>(
    db,
    `SELECT batch_id, batch_number, expiry_date, quantity_on_hand, quantity_received, unit_price::float AS unit_price, supplier,
            (expiry_date < $2::date) AS expired
       FROM medicine_batches WHERE medicine_id = $1 ORDER BY expiry_date, batch_id`,
    [medicineId, istDateString()],
  );
}

export async function stockMovements(db: Db, medicineId: string, limit = 25) {
  return many<{ movement_id: number; kind: string; quantity: number; reference: string | null; created_at: Date; batch_number: string; actor: string | null }>(
    db,
    `SELECT s.movement_id, s.kind, s.quantity, s.reference, s.created_at, b.batch_number, u.full_name AS actor
       FROM stock_movements s
       JOIN medicine_batches b ON b.batch_id = s.batch_id
       LEFT JOIN staff_users u ON u.user_id = s.actor_id
      WHERE s.medicine_id = $1 ORDER BY s.movement_id DESC LIMIT $2`,
    [medicineId, limit],
  );
}
