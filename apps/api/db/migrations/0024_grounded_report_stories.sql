ALTER TABLE report_video_drafts
  ADD COLUMN story_text text,
  ADD COLUMN story_facts jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN report_video_drafts.story_text IS
  'Human-reviewable narrative generated only from confirmed selected media assignments and recorded care logs.';
COMMENT ON COLUMN report_video_drafts.story_facts IS
  'Auditable pet companions, recorded moments, and media counts used to generate story_text.';
