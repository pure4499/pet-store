-- UCBarkley database inspection helpers.
-- Run individual statements from the Microsoft PostgreSQL extension.

-- All application tables and their approximate row counts.
SELECT
  schemaname,
  relname AS table_name,
  n_live_tup AS approximate_rows
FROM pg_stat_user_tables
ORDER BY schemaname, relname;

-- Columns, data types, nullability, and defaults for every public table.
SELECT
  table_name,
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- Foreign-key relationships between public tables.
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS referenced_table,
  ccu.column_name AS referenced_column,
  tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.constraint_schema = kcu.constraint_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.constraint_schema = ccu.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
ORDER BY tc.table_name, kcu.column_name;

-- Tenant data is protected by row-level security when connected as
-- pethotel_app. First choose an organization explicitly:
--
-- SELECT id, name, slug FROM organizations ORDER BY name;
-- SELECT set_config('app.current_org_id', '<organization UUID>', false);
--
-- Then queries such as these will return only that organization's records:
-- SELECT * FROM households ORDER BY created_at DESC LIMIT 100;
-- SELECT * FROM owners ORDER BY full_name LIMIT 100;
-- SELECT * FROM pets ORDER BY name LIMIT 100;
