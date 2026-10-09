ALTER TABLE photos
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id),
  ADD COLUMN deletion_reason text;

CREATE INDEX ix_photos_org_active
  ON photos (organization_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

-- Keep deleted uploads out of the development poller. The object itself is
-- retained for audit/recovery, but no deleted row may re-enter AI processing.
CREATE OR REPLACE FUNCTION claim_next_uploaded_photos(p_limit int)
RETURNS TABLE (id uuid, organization_id uuid, storage_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE photos
  SET processing_status = 'processing'
  WHERE id IN (
    SELECT ph.id FROM photos ph
    WHERE ph.processing_status = 'uploaded'
      AND ph.deleted_at IS NULL
    ORDER BY ph.uploaded_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING photos.id, photos.organization_id, photos.storage_key;
$$;

REVOKE ALL ON FUNCTION claim_next_uploaded_photos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_uploaded_photos(int) TO pethotel_app;
