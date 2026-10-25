-- Chronic care recall (diabetes, hypertension, thyroid) and lab report follow-ups.
-- Both can be fed by Clevo's own consultations or by the hospital's existing HMS through
-- the /api/webhooks/hms endpoint.

CREATE TABLE care_plans (
  plan_id          text PRIMARY KEY,
  patient_id       text NOT NULL REFERENCES patients(patient_id),
  condition        text NOT NULL CHECK (condition IN ('diabetes', 'hypertension', 'thyroid')),
  interval_days    integer NOT NULL CHECK (interval_days BETWEEN 7 AND 400),
  last_visit_date  date NOT NULL,
  next_due_date    date NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  reminders_sent   integer NOT NULL DEFAULT 0,
  last_reminded_at timestamptz,
  source           text NOT NULL DEFAULT 'clevo' CHECK (source IN ('clevo', 'hms')),
  notes            text,
  correlation_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, condition),
  CHECK (next_due_date > last_visit_date)
);
CREATE INDEX care_plans_due_idx ON care_plans (status, next_due_date);

-- diagnostic_tasks existed from the start without a workflow. It now carries lab reports.
ALTER TABLE diagnostic_tasks
  ADD COLUMN test_name      text,
  ADD COLUMN doctor_name    text,
  ADD COLUMN result_flag    text CHECK (result_flag IN ('normal', 'abnormal')),
  ADD COLUMN notified_at    timestamptz,
  ADD COLUMN reviewed_at    timestamptz,
  ADD COLUMN reviewed_by    text REFERENCES staff_users(user_id),
  ADD COLUMN source         text NOT NULL DEFAULT 'clevo',
  ADD COLUMN correlation_id text,
  ADD COLUMN external_id    text;
-- An HMS resending the same report must not create a second task.
CREATE UNIQUE INDEX diagnostic_tasks_external_idx ON diagnostic_tasks (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX diagnostic_tasks_open_idx ON diagnostic_tasks (review_status, report_ready_at);
