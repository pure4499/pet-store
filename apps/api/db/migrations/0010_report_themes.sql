UPDATE report_video_drafts
SET template = 'storybook'
WHERE template = 'daily_highlight_vertical';

ALTER TABLE report_video_drafts
  ALTER COLUMN template SET DEFAULT 'storybook';

ALTER TABLE report_video_drafts
  ADD CONSTRAINT ck_report_video_drafts_template
  CHECK (template IN ('storybook', 'timeline_diary', 'care_card', 'photo_journal', 'postcard'));
