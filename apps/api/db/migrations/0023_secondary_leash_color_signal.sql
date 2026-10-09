-- Optional secondary color evidence for difficult pet identity matches.
-- Appearance embeddings remain the primary identity signal; these fields only
-- retain auditable evidence when a leash-like narrow color region is visible.
ALTER TABLE photo_detections
  ADD COLUMN accessory_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN match_signals jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN photo_detections.accessory_attributes IS
  'Conservative visual accessory evidence such as a visible leash color; absence is neutral.';
COMMENT ON COLUMN photo_detections.match_signals IS
  'Auditable primary appearance and bounded secondary-signal scores used for the suggested identity.';
