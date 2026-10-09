-- Refresh only untouched preset-generated messages. Custom staff notes are
-- deliberately preserved even when they belong to the same preset.
UPDATE daily_log_entries
SET body = CASE structured_data->>'presetId'
  WHEN 'feeding' THEN 'Yum! Mealtime went great.'
  WHEN 'water' THEN 'Fresh water and happy sips!'
  WHEN 'potty' THEN 'Potty time went great!'
  WHEN 'walk' THEN 'We had a lovely little walk!'
  WHEN 'play' THEN 'So much fun at playtime!'
  WHEN 'rest' THEN 'Cozy, comfy rest time.'
  WHEN 'medication' THEN 'Medication was given with care.'
  WHEN 'grooming' THEN 'Freshened up and looking extra cute!'
  WHEN 'happy_social' THEN 'Lots of happy moments with friends today!'
  ELSE body
END,
updated_at = now()
WHERE (structured_data->>'presetId', body) IN (
  ('feeding', 'Meal served.'),
  ('water', 'Fresh water provided.'),
  ('potty', 'Potty break completed.'),
  ('walk', 'Walk completed.'),
  ('play', 'Playtime completed.'),
  ('rest', 'Resting comfortably.'),
  ('medication', 'Medication update recorded.'),
  ('grooming', 'Grooming care completed.'),
  ('happy_social', 'Happy and social today.')
);
