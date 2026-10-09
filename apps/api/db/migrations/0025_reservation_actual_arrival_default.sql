-- A reservation has a scheduled arrival, but no actual arrival until check-in.
-- The original sessions schema defaulted check_in_at to now(), which conflicts
-- with ck_sessions_actual_arrival_by_status for reserved sessions.
ALTER TABLE sessions
  ALTER COLUMN check_in_at DROP DEFAULT;

