-- Preserve identity media isolation while allowing a manager to deliberately
-- reuse a strong check-in frame as private report media. The copied logical
-- photo retains lineage to its identity-only source and can be independently
-- reviewed, published, or soft-deleted.

ALTER TABLE photos
  ADD COLUMN source_identity_photo_id uuid REFERENCES photos(id);

CREATE UNIQUE INDEX uq_photos_active_identity_promotion
  ON photos (organization_id, source_identity_photo_id)
  WHERE source_identity_photo_id IS NOT NULL AND deleted_at IS NULL;

