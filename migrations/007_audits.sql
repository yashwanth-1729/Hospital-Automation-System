-- The paid discovery product (blueprint sections AB and AC): a structured audit of one
-- hospital's patient journey, its measured leakage, and the pilot it justifies.
--
-- This is commercial data about a prospect, not patient data: no patient records here.

CREATE TABLE audits (
  audit_id        text PRIMARY KEY,
  hospital_name   text NOT NULL,
  city            text,
  contact_name    text,
  contact_role    text,
  conducted_by    text,
  conducted_on    date NOT NULL DEFAULT CURRENT_DATE,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  -- Numbers the hospital gave us, plus the assumptions used to estimate leakage.
  inputs          jsonb NOT NULL DEFAULT '{}',
  -- 1-5 scores across the blueprint's readiness dimensions.
  scores          jsonb NOT NULL DEFAULT '{}',
  -- Free-text observations: current journey, systems in use, manual steps.
  notes           jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audits_created_idx ON audits (created_at DESC);
