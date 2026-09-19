-- Core schema. Mirrors the blueprint data model (section E) plus a durable
-- job queue. Every write that could reach a patient has a unique dedupe key.

CREATE TABLE departments (
  department_id text PRIMARY KEY,           -- e.g. 'cardiology'
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE doctors (
  doctor_id     text PRIMARY KEY,
  department_id text NOT NULL REFERENCES departments(department_id),
  full_name     text NOT NULL,
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE patients (
  patient_id     text PRIMARY KEY,
  full_name      text NOT NULL,
  phone          text NOT NULL UNIQUE,       -- E.164, e.g. +919999999999
  email          text,
  city           text,
  source         text,
  consent_status text NOT NULL DEFAULT 'unknown'
                 CHECK (consent_status IN ('granted', 'denied', 'unknown')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slots (
  slot_id        text PRIMARY KEY,
  doctor_id      text NOT NULL REFERENCES doctors(doctor_id),
  department_id  text NOT NULL REFERENCES departments(department_id),
  slot_start     timestamptz NOT NULL,
  slot_end       timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'blocked')),
  appointment_id text,
  UNIQUE (doctor_id, slot_start),
  CHECK (slot_end > slot_start)
);
CREATE INDEX slots_lookup_idx ON slots (department_id, status, slot_start);

CREATE TABLE leads (
  lead_id              text PRIMARY KEY,
  patient_id           text NOT NULL REFERENCES patients(patient_id),
  idempotency_key      text NOT NULL UNIQUE,
  correlation_id       text NOT NULL UNIQUE,
  source               text NOT NULL,
  campaign             text,
  enquiry_text         text NOT NULL,
  department_requested text,
  preferred_date       date,
  department           text REFERENCES departments(department_id),
  enquiry_type         text,
  patient_status       text CHECK (patient_status IN ('new', 'existing', 'unknown')),
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'review')),
  status               text NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'booked', 'needs_review', 'no_slot', 'closed')),
  owner                text,
  ai_result            jsonb,
  appointment_id       text,
  first_response_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_created_idx ON leads (created_at DESC);
CREATE INDEX leads_status_idx ON leads (status);

CREATE TABLE appointments (
  appointment_id    text PRIMARY KEY,
  patient_id        text NOT NULL REFERENCES patients(patient_id),
  lead_id           text REFERENCES leads(lead_id),
  department_id     text NOT NULL REFERENCES departments(department_id),
  doctor_id         text NOT NULL REFERENCES doctors(doctor_id),
  slot_id           text NOT NULL UNIQUE REFERENCES slots(slot_id),
  slot_start        timestamptz NOT NULL,
  slot_end          timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked', 'cancelled', 'completed')),
  attendance_status text NOT NULL DEFAULT 'pending'
                    CHECK (attendance_status IN ('pending', 'attended', 'no_show')),
  reminder_24h_at   timestamptz,
  reminder_3h_at    timestamptz,
  correlation_id    text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_slot_start_idx ON appointments (slot_start);
-- A lead books at most one appointment.
CREATE UNIQUE INDEX appointments_lead_uidx ON appointments (lead_id) WHERE lead_id IS NOT NULL;

ALTER TABLE leads ADD CONSTRAINT leads_appointment_fk
  FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id);
ALTER TABLE slots ADD CONSTRAINT slots_appointment_fk
  FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id);

CREATE TABLE follow_ups (
  followup_id     text PRIMARY KEY,
  patient_id      text NOT NULL REFERENCES patients(patient_id),
  appointment_id  text REFERENCES appointments(appointment_id),
  category        text NOT NULL,
  approved_date   date,
  approved_window text,
  owner           text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  attempt_count   integer NOT NULL DEFAULT 0,
  next_action_at  timestamptz,
  notes           text,
  dedupe_key      text UNIQUE,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE diagnostic_tasks (
  diagnostic_id       text PRIMARY KEY,
  patient_id          text NOT NULL REFERENCES patients(patient_id),
  encounter_id        text,
  test_category       text NOT NULL,
  ordered_at          timestamptz,
  completed_at        timestamptz,
  report_ready_at     timestamptz,
  review_status       text NOT NULL DEFAULT 'pending',
  notification_status text NOT NULL DEFAULT 'pending',
  owner               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE communication_log (
  message_id          text PRIMARY KEY,
  dedupe_key          text NOT NULL UNIQUE,
  patient_id          text REFERENCES patients(patient_id),
  recipient           text NOT NULL,
  channel             text NOT NULL,
  provider            text NOT NULL,
  template_name       text NOT NULL,
  workflow_name       text NOT NULL,
  body                text NOT NULL,
  -- sending: handed to provider, outcome unknown until updated
  delivery_status     text NOT NULL
                      CHECK (delivery_status IN ('sending', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  skip_reason         text,
  provider_message_id text,
  error               text,
  response_status     text,
  correlation_id      text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX communication_log_recipient_idx ON communication_log (recipient, created_at);
CREATE INDEX communication_log_correlation_idx ON communication_log (correlation_id);

CREATE TABLE exceptions (
  exception_id    text PRIMARY KEY,
  workflow_name   text NOT NULL,
  record_id       text,
  error_type      text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  owner           text,
  due_at          timestamptz,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  summary         text NOT NULL,
  details         jsonb,
  resolution_note text,
  dedupe_key      text UNIQUE,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX exceptions_open_idx ON exceptions (status, severity, created_at);

CREATE TABLE audit_log (
  event_id         bigserial PRIMARY KEY,
  workflow_name    text NOT NULL,
  workflow_version text NOT NULL,
  actor_type       text NOT NULL CHECK (actor_type IN ('system', 'ai', 'staff', 'patient', 'integration')),
  action           text NOT NULL,
  record_id        text,
  details          jsonb,
  correlation_id   text,
  timestamp        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_correlation_idx ON audit_log (correlation_id, event_id);

-- Durable job queue. Workers claim with FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  job_id       bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'dead', 'cancelled')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error   text,
  locked_by    text,
  locked_at    timestamptz,
  correlation_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen timestamptz NOT NULL DEFAULT now(),
  info      jsonb
);
