ALTER TABLE report_video_drafts
  ADD COLUMN visual_style text NOT NULL DEFAULT 'clean'
  CHECK (visual_style IN ('clean', 'sticker_dots', 'cartoon_title'));
