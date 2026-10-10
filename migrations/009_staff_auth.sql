-- Per-person staff accounts, replacing the single shared dashboard password.
--
-- Clinical records (consultations, prescriptions, bills) must be attributable to a named person
-- and visible only to the roles that need them. Sessions live in the database so that
-- deactivating someone, or resetting a password, takes effect immediately.

CREATE TABLE staff_users (
  user_id              text PRIMARY KEY,
  email                text NOT NULL,
  full_name            text NOT NULL,
  role                 text NOT NULL
                       CHECK (role IN ('admin', 'receptionist', 'doctor', 'pharmacist', 'billing', 'nurse')),
  -- A doctor account is bound to a doctor record: that is how "my patients" is decided.
  doctor_id            text REFERENCES doctors(doctor_id),
  password_hash        text NOT NULL,
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_doctor_needs_record CHECK (role <> 'doctor' OR doctor_id IS NOT NULL)
);
CREATE UNIQUE INDEX staff_users_email_uidx ON staff_users (lower(email));
-- One login per doctor record, so a consultation can name exactly who saw the patient.
CREATE UNIQUE INDEX staff_users_doctor_uidx ON staff_users (doctor_id) WHERE doctor_id IS NOT NULL;

-- Only a hash of the session token is stored, so a database leak does not hand out live sessions.
CREATE TABLE staff_sessions (
  session_hash text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES staff_users(user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX staff_sessions_user_idx ON staff_sessions (user_id);
CREATE INDEX staff_sessions_expiry_idx ON staff_sessions (expires_at);

-- Failed sign-ins by address, so one source cannot guess across many accounts.
CREATE TABLE login_failures (
  id    bigserial PRIMARY KEY,
  ip    text NOT NULL,
  email text,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failures_ip_idx ON login_failures (ip, at);

-- Who did it. Filled for staff actions; system and patient events leave it empty.
ALTER TABLE audit_log ADD COLUMN actor_id text;
