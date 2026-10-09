-- Preserve the manager-selected hero photo on each generated report.
ALTER TABLE report_video_drafts
  ADD COLUMN main_photo_id uuid REFERENCES photos(id);

