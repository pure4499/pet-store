-- Reservations are planned stays that become the same operational session at
-- check-in. Keep scheduled and actual arrival timestamps distinct.
ALTER TABLE sessions
  DROP CONSTRAINT sessions_status_check;

ALTER TABLE sessions
  ALTER COLUMN check_in_at DROP NOT NULL,
  ADD COLUMN scheduled_check_in_at timestamptz,
  ADD COLUMN reserved_at timestamptz,
  ADD COLUMN reserved_by uuid REFERENCES users(id),
  ADD COLUMN reservation_group_id uuid,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid REFERENCES users(id);

UPDATE sessions
SET scheduled_check_in_at = check_in_at
WHERE scheduled_check_in_at IS NULL;

ALTER TABLE sessions
  ALTER COLUMN scheduled_check_in_at SET NOT NULL,
  ALTER COLUMN scheduled_check_in_at SET DEFAULT now(),
  ADD CONSTRAINT sessions_status_check
    CHECK (status IN ('reserved','active','checked_out','cancelled')),
  ADD CONSTRAINT ck_sessions_actual_arrival_by_status
    CHECK (
      (status = 'reserved' AND check_in_at IS NULL AND checked_in_by IS NULL)
      OR (status IN ('active','checked_out') AND check_in_at IS NOT NULL)
      OR status = 'cancelled'
    );

CREATE INDEX ix_sessions_org_scheduled
  ON sessions (organization_id, scheduled_check_in_at)
  WHERE status = 'reserved';
