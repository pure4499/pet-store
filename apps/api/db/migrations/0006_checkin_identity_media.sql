-- Check-in identity enrollment media is deliberately separate from report
-- media. Arrival photos and video frames may train/match the pet's current
-- appearance, but must never be surfaced to owners unless staff later upload
-- them again through the ordinary report-media workflow.

ALTER TABLE photos
  ADD COLUMN media_purpose text NOT NULL DEFAULT 'report_media'
    CHECK (media_purpose IN ('report_media', 'identity_reference')),
  ADD COLUMN reference_pet_id uuid REFERENCES pets(id),
  ADD COLUMN reference_session_id uuid REFERENCES sessions(id),
  ADD COLUMN source_video_id uuid REFERENCES videos(id);

ALTER TABLE photos
  ADD CONSTRAINT ck_photos_identity_reference_target CHECK (
    (media_purpose = 'report_media' AND reference_pet_id IS NULL AND reference_session_id IS NULL) OR
    (media_purpose = 'identity_reference' AND reference_pet_id IS NOT NULL AND reference_session_id IS NOT NULL)
  );

CREATE INDEX ix_photos_identity_session
  ON photos (reference_session_id, created_at DESC)
  WHERE media_purpose = 'identity_reference';

CREATE UNIQUE INDEX uq_reference_embedding_source_detection
  ON pet_reference_embeddings (source_detection_id)
  WHERE source_detection_id IS NOT NULL;

ALTER TABLE videos
  ADD COLUMN media_purpose text NOT NULL DEFAULT 'report_media'
    CHECK (media_purpose IN ('report_media', 'identity_reference')),
  ADD COLUMN reference_pet_id uuid REFERENCES pets(id),
  ADD COLUMN reference_session_id uuid REFERENCES sessions(id),
  ADD COLUMN processing_status text NOT NULL DEFAULT 'processed'
    CHECK (processing_status IN ('queued', 'uploaded', 'processing', 'processed', 'failed')),
  ADD COLUMN processing_error text,
  ADD COLUMN extracted_frame_count int NOT NULL DEFAULT 0;

ALTER TABLE videos
  ADD CONSTRAINT ck_videos_identity_reference_target CHECK (
    (media_purpose = 'report_media' AND reference_pet_id IS NULL AND reference_session_id IS NULL) OR
    (media_purpose = 'identity_reference' AND reference_pet_id IS NOT NULL AND reference_session_id IS NOT NULL)
  );

CREATE INDEX ix_videos_identity_queue
  ON videos (processing_status, uploaded_at)
  WHERE media_purpose = 'identity_reference' AND processing_status = 'uploaded';

-- The local worker must discover jobs before it knows which tenant scope to
-- establish. This narrow claim function mirrors the existing photo queue.
CREATE OR REPLACE FUNCTION claim_next_identity_videos(p_limit int)
RETURNS TABLE (id uuid, organization_id uuid, storage_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE videos
  SET processing_status = 'processing', processing_error = NULL
  WHERE id IN (
    SELECT v.id FROM videos v
    WHERE v.media_purpose = 'identity_reference'
      AND v.processing_status = 'uploaded'
    ORDER BY v.uploaded_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING videos.id, videos.organization_id, videos.storage_key;
$$;

REVOKE ALL ON FUNCTION claim_next_identity_videos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_identity_videos(int) TO pethotel_app;
