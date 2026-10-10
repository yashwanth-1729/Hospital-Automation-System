-- Inpatient care: wards and beds, admissions, and the beds a patient actually occupied.

CREATE TABLE wards (
  ward_id    text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('general', 'semi_private', 'private', 'icu', 'day_care')),
  daily_rate numeric(10, 2) NOT NULL CHECK (daily_rate >= 0),
  active     boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX wards_name_uidx ON wards (lower(name));

CREATE TABLE beds (
  bed_id  text PRIMARY KEY,
  ward_id text NOT NULL REFERENCES wards(ward_id),
  label   text NOT NULL,
  -- cleaning: just vacated, not yet ready for the next patient.
  status  text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'cleaning', 'maintenance')),
  active  boolean NOT NULL DEFAULT true,
  UNIQUE (ward_id, label)
);
CREATE INDEX beds_status_idx ON beds (status) WHERE active;

CREATE TABLE admissions (
  admission_id      text PRIMARY KEY,
  patient_id        text NOT NULL REFERENCES patients(patient_id),
  doctor_id         text NOT NULL REFERENCES doctors(doctor_id),
  department_id     text NOT NULL REFERENCES departments(department_id),
  status            text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'discharged')),
  reason            text,
  expected_discharge date,
  admitted_at       timestamptz NOT NULL DEFAULT now(),
  discharged_at     timestamptz,
  discharge_id      text REFERENCES discharges(discharge_id),
  admitted_by       text REFERENCES staff_users(user_id),
  discharged_by     text REFERENCES staff_users(user_id),
  correlation_id    text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (discharged_at IS NULL OR discharged_at >= admitted_at)
);
-- Someone cannot be in two beds at once.
CREATE UNIQUE INDEX admissions_one_active_uidx ON admissions (patient_id) WHERE status = 'admitted';
CREATE INDEX admissions_status_idx ON admissions (status, admitted_at DESC);

-- Each bed a patient occupied, with the rate in force then, so charges stay right after a
-- transfer or a later change of ward rate.
CREATE TABLE bed_stays (
  stay_id       text PRIMARY KEY,
  admission_id  text NOT NULL REFERENCES admissions(admission_id),
  bed_id        text NOT NULL REFERENCES beds(bed_id),
  ward_id       text NOT NULL REFERENCES wards(ward_id),
  daily_rate    numeric(10, 2) NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  ended_reason  text CHECK (ended_reason IN ('transfer', 'discharge')),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
-- A bed holds one patient, and an admission is in one bed, at a time.
CREATE UNIQUE INDEX bed_stays_open_bed_uidx ON bed_stays (bed_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX bed_stays_open_admission_uidx ON bed_stays (admission_id) WHERE ended_at IS NULL;
CREATE INDEX bed_stays_admission_idx ON bed_stays (admission_id, started_at);

ALTER TABLE invoices ADD COLUMN admission_id text REFERENCES admissions(admission_id);
CREATE INDEX invoices_admission_idx ON invoices (admission_id);
