ALTER TABLE report_video_drafts
  ADD COLUMN music_style text NOT NULL DEFAULT 'warm_story'
  CHECK (music_style IN (
    'none',
    'warm_story',
    'day_in_motion',
    'gentle_care',
    'dreamy_memories',
    'sunny_postcard'
  ));
