-- The clinical record: vitals, the case sheet, and the prescription that leaves the consulting room.

-- The formulary doctors prescribe from. Stock lives with the pharmacy (a later migration);
-- the catalogue is separate so a medicine can be prescribed whether or not it is on the shelf.
CREATE TABLE medicines (
  medicine_id  text PRIMARY KEY,
  name         text NOT NULL,                 -- as written on a prescription, e.g. 'Paracetamol 500 mg'
  generic_name text NOT NULL,
  form         text NOT NULL,                 -- tablet, capsule, syrup, injection, ointment, drops, ...
  unit         text NOT NULL DEFAULT 'unit',  -- what one dose is counted in: tablet, ml, application
  active       boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX medicines_name_uidx ON medicines (lower(name));

CREATE TABLE vitals (
  vital_id     text PRIMARY KEY,
  visit_id     text NOT NULL REFERENCES visits(visit_id),
  patient_id   text NOT NULL REFERENCES patients(patient_id),
  recorded_by  text NOT NULL REFERENCES staff_users(user_id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  bp_systolic  integer CHECK (bp_systolic BETWEEN 40 AND 300),
  bp_diastolic integer CHECK (bp_diastolic BETWEEN 20 AND 200),
  pulse        integer CHECK (pulse BETWEEN 20 AND 250),
  temperature_c numeric(4, 1) CHECK (temperature_c BETWEEN 30 AND 45),
  spo2         integer CHECK (spo2 BETWEEN 50 AND 100),
  resp_rate    integer CHECK (resp_rate BETWEEN 4 AND 80),
  weight_kg    numeric(5, 1) CHECK (weight_kg BETWEEN 0.3 AND 400),
  height_cm    numeric(5, 1) CHECK (height_cm BETWEEN 20 AND 260),
  notes        text,
  CONSTRAINT vitals_not_empty CHECK (
    bp_systolic IS NOT NULL OR pulse IS NOT NULL OR temperature_c IS NOT NULL OR spo2 IS NOT NULL
    OR resp_rate IS NOT NULL OR weight_kg IS NOT NULL OR height_cm IS NOT NULL
  )
);
CREATE INDEX vitals_visit_idx ON vitals (visit_id, recorded_at DESC);
CREATE INDEX vitals_patient_idx ON vitals (patient_id, recorded_at DESC);

CREATE TABLE consultations (
  consultation_id text PRIMARY KEY,
  visit_id        text NOT NULL UNIQUE REFERENCES visits(visit_id),
  patient_id      text NOT NULL REFERENCES patients(patient_id),
  doctor_id       text NOT NULL REFERENCES doctors(doctor_id),
  written_by      text NOT NULL REFERENCES staff_users(user_id),
  chief_complaint text,
  history         text,
  examination     text,
  diagnosis       text,
  advice          text,
  follow_up_date  date,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  finalised_at    timestamptz,
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A finished record always says what was diagnosed.
  CONSTRAINT consultation_final_has_diagnosis CHECK (status <> 'final' OR length(btrim(coalesce(diagnosis, ''))) > 0)
);
CREATE INDEX consultations_patient_idx ON consultations (patient_id, created_at DESC);

-- A finalised case sheet is never edited in place. Later notes are added, with who and when.
CREATE TABLE consultation_addenda (
  addendum_id     text PRIMARY KEY,
  consultation_id text NOT NULL REFERENCES consultations(consultation_id),
  written_by      text NOT NULL REFERENCES staff_users(user_id),
  note            text NOT NULL CHECK (length(btrim(note)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consultation_addenda_idx ON consultation_addenda (consultation_id, created_at);

CREATE TABLE prescriptions (
  prescription_id  text PRIMARY KEY,
  consultation_id  text NOT NULL UNIQUE REFERENCES consultations(consultation_id),
  visit_id         text NOT NULL REFERENCES visits(visit_id),
  patient_id       text NOT NULL REFERENCES patients(patient_id),
  doctor_id        text NOT NULL REFERENCES doctors(doctor_id),
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'issued', 'partially_dispensed', 'dispensed', 'cancelled')),
  issued_at        timestamptz,
  -- Set when the doctor prescribed something the patient's recorded allergies mention.
  allergy_override_reason text,
  correlation_id   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_status_idx ON prescriptions (status, issued_at);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, issued_at DESC);

CREATE TABLE prescription_items (
  item_id         text PRIMARY KEY,
  prescription_id text NOT NULL REFERENCES prescriptions(prescription_id) ON DELETE CASCADE,
  position        integer NOT NULL,
  medicine_id     text REFERENCES medicines(medicine_id),
  medicine_name   text NOT NULL,
  dose_units      numeric(6, 2) NOT NULL CHECK (dose_units > 0),
  frequency       text NOT NULL CHECK (frequency IN ('OD', 'BD', 'TDS', 'QID', 'HS', 'SOS')),
  duration_days   integer NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
  timing          text NOT NULL DEFAULT 'any' CHECK (timing IN ('any', 'before_food', 'after_food', 'with_food')),
  quantity        integer NOT NULL CHECK (quantity > 0),
  instructions    text,
  dispensed_qty   integer NOT NULL DEFAULT 0 CHECK (dispensed_qty >= 0),
  UNIQUE (prescription_id, position),
  CHECK (dispensed_qty <= quantity)
);
