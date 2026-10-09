-- Identity references are operational training inputs, not report media. Keep
-- their audit record and stored object recoverable while allowing managers to
-- remove stale or incorrect images from the active matching corpus.

ALTER TABLE photos
  ADD COLUMN identity_reference_removed_at timestamptz,
  ADD COLUMN identity_reference_removed_by uuid REFERENCES users(id);

CREATE INDEX ix_photos_active_identity_session
  ON photos (reference_session_id, created_at DESC)
  WHERE media_purpose = 'identity_reference'
    AND identity_reference_removed_at IS NULL;
