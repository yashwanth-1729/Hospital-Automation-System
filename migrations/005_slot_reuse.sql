-- A cancelled appointment keeps its slot_id for history, but must not block that slot
-- from being booked again. Uniqueness therefore applies only to live appointments.

ALTER TABLE appointments DROP CONSTRAINT appointments_slot_id_key;

CREATE UNIQUE INDEX appointments_live_slot_uidx
  ON appointments (slot_id)
  WHERE status <> 'cancelled';

-- Same reasoning for the one-appointment-per-lead rule: a cancelled booking should not
-- stop staff from booking that patient again from the same enquiry.
DROP INDEX appointments_lead_uidx;

CREATE UNIQUE INDEX appointments_live_lead_uidx
  ON appointments (lead_id)
  WHERE lead_id IS NOT NULL AND status <> 'cancelled';
