-- A report's publication date is independent from the span of stay media it
-- summarizes. Existing reports remain single-day reports.
ALTER TABLE report_video_drafts
  ADD COLUMN media_window text NOT NULL DEFAULT 'report_day';

ALTER TABLE report_video_drafts
  ADD CONSTRAINT ck_report_video_drafts_media_window
  CHECK (media_window IN ('report_day', 'last_2_days', 'last_3_days', 'full_stay'));
