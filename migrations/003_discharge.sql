-- Discharge follow-up and feedback (blueprint section R).
--
-- Deliberately stores NO clinical content: no diagnosis, no medication, no instructions.
-- Only the administrative facts needed to coordinate a follow-up that a clinician already approved.

CREATE TABLE discharges (
  discharge_id             text PRIMARY KEY,
  patient_id               text NOT NULL REFERENCES patients(patient_id),
  encounter_id             text,
  department_id            text REFERENCES departments(department_id),
  discharged_at            timestamptz NOT NULL,
  -- Supplied by the hospital. Never inferred, never generated.
  approved_followup_date   date,
  approved_followup_window text,
  approved_by              text,
  source                   text NOT NULL,
  status                   text NOT NULL DEFAULT 'new'
                           CHECK (status IN ('new', 'scheduled', 'needs_review', 'closed')),
  idempotency_key          text NOT NULL UNIQUE,
  correlation_id           text NOT NULL UNIQUE,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discharges_created_idx ON discharges (created_at DESC);

ALTER TABLE follow_ups ADD COLUMN discharge_id text REFERENCES discharges(discharge_id);

-- One-time link a patient opens to rate their visit.
CREATE TABLE feedback_requests (
  token          text PRIMARY KEY,
  patient_id     text NOT NULL REFERENCES patients(patient_id),
  discharge_id   text REFERENCES discharges(discharge_id),
  appointment_id text REFERENCES appointments(appointment_id),
  correlation_id text,
  expires_at     timestamptz NOT NULL,
  responded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_requests_patient_idx ON feedback_requests (patient_id);

CREATE TABLE feedback (
  feedback_id    text PRIMARY KEY,
  token          text NOT NULL UNIQUE REFERENCES feedback_requests(token),
  patient_id     text NOT NULL REFERENCES patients(patient_id),
  discharge_id   text REFERENCES discharges(discharge_id),
  rating         integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        text,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_created_idx ON feedback (created_at DESC);
