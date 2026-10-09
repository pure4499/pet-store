-- Mobile check-ins may be retried after a connection drops after the server
-- commits but before the phone receives the response. A client-generated UUID
-- lets every retry resolve to the original stay instead of creating another.
ALTER TABLE sessions
  ADD COLUMN client_check_in_id uuid;

ALTER TABLE sessions
  ADD CONSTRAINT uq_sessions_client_check_in
  UNIQUE (organization_id, client_check_in_id);

