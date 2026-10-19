-- Radiology: a new staff role, and imaging orders that flow from the doctor to the radiology
-- worklist and back as a report.

ALTER TABLE staff_users DROP CONSTRAINT staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check
  CHECK (role IN ('admin', 'receptionist', 'doctor', 'pharmacist', 'billing', 'nurse', 'radiology'));

CREATE TABLE imaging_orders (
  order_id       text PRIMARY KEY,
  patient_id     text NOT NULL REFERENCES patients(patient_id),
  visit_id       text REFERENCES visits(visit_id),
  doctor_id      text NOT NULL REFERENCES doctors(doctor_id),
  ordered_by     text NOT NULL REFERENCES staff_users(user_id),
  study          text NOT NULL,
  modality       text NOT NULL CHECK (modality IN ('xray', 'ultrasound', 'ct', 'mri', 'ecg', 'other')),
  indication     text,
  priority       text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'urgent')),
  status         text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'in_progress', 'reported', 'cancelled')),
  findings       text,
  impression     text,
  started_by     text REFERENCES staff_users(user_id),
  reported_by    text REFERENCES staff_users(user_id),
  ordered_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  reported_at    timestamptz,
  correlation_id text NOT NULL,
  -- A report always says what was concluded.
  CONSTRAINT imaging_report_has_impression CHECK (status <> 'reported' OR length(btrim(coalesce(impression, ''))) > 0)
);
CREATE INDEX imaging_worklist_idx ON imaging_orders (status, priority, ordered_at);
CREATE INDEX imaging_patient_idx ON imaging_orders (patient_id, ordered_at DESC);
CREATE INDEX imaging_visit_idx ON imaging_orders (visit_id);
