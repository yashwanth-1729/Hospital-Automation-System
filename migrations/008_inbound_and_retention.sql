-- Inbound WhatsApp: delivery receipts and patient replies.
--
-- Until now a message stopped at 'sent' — we knew we had handed it to the provider, but not
-- whether it reached the patient. Meta reports that back over a webhook, and patients reply
-- on the same channel, including to opt out. Both arrive here.

ALTER TABLE communication_log
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN read_at timestamptz;

-- Consent is a record, not just a flag: when it changed and what changed it.
ALTER TABLE patients
  ADD COLUMN consent_updated_at timestamptz,
  ADD COLUMN consent_source text;

CREATE TABLE inbound_messages (
  inbound_id          text PRIMARY KEY,
  -- Meta retries webhooks, so the provider's id is the dedupe key.
  provider_message_id text UNIQUE,
  patient_id          text REFERENCES patients(patient_id),
  from_number         text NOT NULL,
  body                text,
  kind                text NOT NULL DEFAULT 'text',
  -- What the system did with it: opt_out, opt_in, escalated, staff_review, ignored.
  handled_as          text,
  correlation_id      text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_messages_patient_idx ON inbound_messages (patient_id, received_at DESC);

-- Retention (DPDP Act 2023: keep personal data no longer than the purpose needs).
-- Rows record what was purged and when, so the hospital can evidence the policy running.
CREATE TABLE retention_runs (
  run_id            bigserial PRIMARY KEY,
  ran_for_date      date NOT NULL UNIQUE,
  messages_redacted integer NOT NULL DEFAULT 0,
  enquiries_cleared integer NOT NULL DEFAULT 0,
  inbound_cleared   integer NOT NULL DEFAULT 0,
  ran_at            timestamptz NOT NULL DEFAULT now()
);
