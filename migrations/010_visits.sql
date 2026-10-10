-- Reception: a full patient record, and the visit (one attendance on one day) with its queue token.

CREATE SEQUENCE uhid_seq START 1001;

ALTER TABLE patients
  ADD COLUMN uhid                    text UNIQUE,
  ADD COLUMN date_of_birth           date,
  -- Patients often only know their age; the date is then an estimate and shown as such.
  ADD COLUMN dob_estimated           boolean NOT NULL DEFAULT false,
  ADD COLUMN gender                  text CHECK (gender IN ('female', 'male', 'other')),
  ADD COLUMN address                 text,
  ADD COLUMN blood_group             text CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  ADD COLUMN allergies               text,
  ADD COLUMN insurance_provider      text,
  ADD COLUMN insurance_policy_no     text,
  ADD COLUMN emergency_contact_name  text,
  ADD COLUMN emergency_contact_phone text;

-- Hospital-wide patient number. Existing patients (from WhatsApp enquiries) get one too.
UPDATE patients SET uhid = 'UH-' || lpad(nextval('uhid_seq')::text, 6, '0') WHERE uhid IS NULL;
ALTER TABLE patients ALTER COLUMN uhid SET DEFAULT ('UH-' || lpad(nextval('uhid_seq')::text, 6, '0'));
ALTER TABLE patients ALTER COLUMN uhid SET NOT NULL;

CREATE TABLE visits (
  visit_id          text PRIMARY KEY,
  patient_id        text NOT NULL REFERENCES patients(patient_id),
  appointment_id    text REFERENCES appointments(appointment_id),
  department_id     text NOT NULL REFERENCES departments(department_id),
  doctor_id         text NOT NULL REFERENCES doctors(doctor_id),
  visit_date        date NOT NULL,                       -- IST calendar day
  token_number      integer NOT NULL CHECK (token_number > 0),
  source            text NOT NULL CHECK (source IN ('walk_in', 'appointment')),
  status            text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'in_consultation', 'completed', 'cancelled')),
  priority          text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  reason            text,
  checked_in_at     timestamptz NOT NULL DEFAULT now(),
  consult_started_at timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  cancel_reason     text,
  created_by        text,                                -- staff user who checked them in
  correlation_id    text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doctor_id, visit_date, token_number)
);

-- An appointment is checked in at most once.
CREATE UNIQUE INDEX visits_appointment_uidx ON visits (appointment_id) WHERE appointment_id IS NOT NULL;
-- A double click cannot put the same patient in the same doctor's queue twice.
CREATE UNIQUE INDEX visits_active_uidx ON visits (patient_id, doctor_id, visit_date)
  WHERE status IN ('waiting', 'in_consultation');
CREATE INDEX visits_queue_idx ON visits (visit_date, doctor_id, status);
CREATE INDEX visits_patient_idx ON visits (patient_id, visit_date DESC);

-- Per doctor, per day: the last token handed out. Incremented atomically, so two reception
-- desks can never issue the same number.
CREATE TABLE visit_tokens (
  doctor_id  text NOT NULL REFERENCES doctors(doctor_id),
  visit_date date NOT NULL,
  last_token integer NOT NULL DEFAULT 0,
  PRIMARY KEY (doctor_id, visit_date)
);
