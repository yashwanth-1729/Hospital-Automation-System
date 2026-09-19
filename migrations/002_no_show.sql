-- No-show recovery (blueprint section Q): who marked attendance and when,
-- so recovery messaging and reporting can be driven off a single source of truth.

ALTER TABLE appointments
  ADD COLUMN attendance_marked_at timestamptz,
  ADD COLUMN attendance_marked_by text;

-- Sweep query: find visits that have passed without attendance being recorded.
CREATE INDEX appointments_pending_attendance_idx
  ON appointments (slot_end)
  WHERE status = 'booked' AND attendance_status = 'pending';

CREATE INDEX follow_ups_open_idx ON follow_ups (status, next_action_at);
