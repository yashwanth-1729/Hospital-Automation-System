-- Staff scheduling actions (cancel / reschedule) and the cached daily management summary.

ALTER TABLE appointments
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_by text,
  ADD COLUMN reschedule_count integer NOT NULL DEFAULT 0;

-- Management summary for one IST day. Holds only aggregate numbers, never patient data.
CREATE TABLE daily_summaries (
  summary_date date PRIMARY KEY,
  metrics      jsonb NOT NULL,
  summary      jsonb NOT NULL,
  provider     text NOT NULL,
  model        text,
  generated_at timestamptz NOT NULL DEFAULT now()
);
