-- Pharmacy: stock by batch with expiry, an append-only movement ledger, and dispensing
-- against issued prescriptions.

ALTER TABLE medicines ADD COLUMN reorder_level integer NOT NULL DEFAULT 20 CHECK (reorder_level >= 0);

CREATE TABLE medicine_batches (
  batch_id          text PRIMARY KEY,
  medicine_id       text NOT NULL REFERENCES medicines(medicine_id),
  batch_number      text NOT NULL,
  expiry_date       date NOT NULL,
  quantity_received integer NOT NULL CHECK (quantity_received > 0),
  quantity_on_hand  integer NOT NULL CHECK (quantity_on_hand >= 0),
  unit_cost         numeric(10, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  unit_price        numeric(10, 2) NOT NULL CHECK (unit_price >= 0),  -- what the patient pays per unit
  supplier          text,
  received_by       text REFERENCES staff_users(user_id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (medicine_id, batch_number),
  CHECK (quantity_on_hand <= quantity_received)
);
-- First-expired-first-out lookups.
CREATE INDEX medicine_batches_fefo_idx ON medicine_batches (medicine_id, expiry_date, batch_id) WHERE quantity_on_hand > 0;

-- Every change to stock, ever. quantity_on_hand is a cache of the sum of this for the batch;
-- the tests assert they agree.
CREATE TABLE stock_movements (
  movement_id bigserial PRIMARY KEY,
  medicine_id text NOT NULL REFERENCES medicines(medicine_id),
  batch_id    text NOT NULL REFERENCES medicine_batches(batch_id),
  kind        text NOT NULL CHECK (kind IN ('receipt', 'dispense', 'adjustment', 'write_off')),
  quantity    integer NOT NULL CHECK (quantity <> 0),   -- negative when stock leaves
  reference   text,                                     -- prescription, dispensation or reason
  actor_id    text REFERENCES staff_users(user_id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_batch_idx ON stock_movements (batch_id, movement_id);
CREATE INDEX stock_movements_medicine_idx ON stock_movements (medicine_id, created_at DESC);

CREATE TABLE dispensations (
  dispensation_id text PRIMARY KEY,
  prescription_id text NOT NULL REFERENCES prescriptions(prescription_id),
  patient_id      text NOT NULL REFERENCES patients(patient_id),
  dispensed_by    text NOT NULL REFERENCES staff_users(user_id),
  dispensed_at    timestamptz NOT NULL DEFAULT now(),
  total_amount    numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  correlation_id  text NOT NULL
);
CREATE INDEX dispensations_prescription_idx ON dispensations (prescription_id);
CREATE INDEX dispensations_patient_idx ON dispensations (patient_id, dispensed_at DESC);

CREATE TABLE dispensation_items (
  dispensation_item_id text PRIMARY KEY,
  dispensation_id      text NOT NULL REFERENCES dispensations(dispensation_id) ON DELETE CASCADE,
  prescription_item_id text NOT NULL REFERENCES prescription_items(item_id),
  medicine_id          text NOT NULL REFERENCES medicines(medicine_id),
  batch_id             text NOT NULL REFERENCES medicine_batches(batch_id),
  quantity             integer NOT NULL CHECK (quantity > 0),
  unit_price           numeric(10, 2) NOT NULL,
  line_total           numeric(12, 2) NOT NULL
);
CREATE INDEX dispensation_items_item_idx ON dispensation_items (prescription_item_id);

-- Why a prescription was closed with items not supplied (out of stock, patient declined).
ALTER TABLE prescriptions ADD COLUMN pharmacy_note text;
