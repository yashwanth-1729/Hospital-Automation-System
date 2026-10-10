-- Billing: invoices built from what actually happened (the consultation, what the pharmacy
-- dispensed) plus services, then paid in one or more payments.

ALTER TABLE doctors ADD COLUMN consultation_fee numeric(10, 2) NOT NULL DEFAULT 500 CHECK (consultation_fee >= 0);

-- Things a hospital charges for that are not medicines: procedures, tests, nursing care.
CREATE TABLE services (
  service_id    text PRIMARY KEY,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'procedure',
  default_price numeric(10, 2) NOT NULL CHECK (default_price >= 0),
  tax_rate      numeric(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  active        boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX services_name_uidx ON services (lower(name));

CREATE SEQUENCE invoice_seq START 1;
CREATE SEQUENCE receipt_seq START 1;

CREATE TABLE invoices (
  invoice_id      text PRIMARY KEY,
  -- Assigned when the invoice is issued, so drafts leave no gaps in the numbering.
  invoice_number  text UNIQUE,
  patient_id      text NOT NULL REFERENCES patients(patient_id),
  visit_id        text REFERENCES visits(visit_id),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'void')),
  subtotal        numeric(12, 2) NOT NULL DEFAULT 0,
  discount_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_reason text,
  tax_amount      numeric(12, 2) NOT NULL DEFAULT 0,
  total           numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid     numeric(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  due_date        date,
  notes           text,
  created_by      text REFERENCES staff_users(user_id),
  issued_by       text REFERENCES staff_users(user_id),
  issued_at       timestamptz,
  voided_by       text REFERENCES staff_users(user_id),
  voided_at       timestamptz,
  void_reason     text,
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_discount_within_subtotal CHECK (discount_amount <= subtotal),
  CONSTRAINT invoice_paid_within_total CHECK (amount_paid <= total),
  CONSTRAINT invoice_number_when_issued CHECK (status IN ('draft') OR invoice_number IS NOT NULL OR status = 'void')
);
CREATE INDEX invoices_patient_idx ON invoices (patient_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (status, issued_at);
CREATE INDEX invoices_visit_idx ON invoices (visit_id);

CREATE TABLE invoice_lines (
  line_id     text PRIMARY KEY,
  invoice_id  text NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  position    integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('consultation', 'pharmacy', 'service', 'bed', 'other')),
  description text NOT NULL,
  quantity    numeric(8, 2) NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
  tax_rate    numeric(5, 2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  line_total  numeric(12, 2) NOT NULL CHECK (line_total >= 0),
  -- What this line bills for (a consultation, a dispensation). Unique, so nothing is billed
  -- twice; voiding an invoice clears it so the item can be billed again.
  source_ref  text UNIQUE,
  UNIQUE (invoice_id, position)
);

CREATE TABLE payments (
  payment_id      text PRIMARY KEY,
  invoice_id      text NOT NULL REFERENCES invoices(invoice_id),
  kind            text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'refund')),
  amount          numeric(12, 2) NOT NULL CHECK (amount > 0),
  method          text NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'insurance', 'other')),
  reference       text,
  reason          text,
  receipt_number  text UNIQUE,
  -- Sent with each payment form, so a double click is one payment.
  idempotency_key text UNIQUE,
  received_by     text NOT NULL REFERENCES staff_users(user_id),
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id, received_at);
CREATE INDEX payments_day_idx ON payments (received_at);
