-- Require users to replace passwords that are at least 60 days old. Earlier
-- schema versions did not record password-change time, so existing accounts
-- begin their first accurately tracked 60-day period when this migration runs.

ALTER TABLE users
  ADD COLUMN password_changed_at timestamptz;

UPDATE users
SET password_changed_at = now();

ALTER TABLE users
  ALTER COLUMN password_changed_at SET DEFAULT now(),
  ALTER COLUMN password_changed_at SET NOT NULL;

DROP FUNCTION find_user_for_login(citext);
CREATE FUNCTION find_user_for_login(p_email citext)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  password_hash text,
  full_name text,
  role text,
  status text,
  auth_version int,
  password_changed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT users.id, users.organization_id, users.password_hash, users.full_name,
         roles.slug, users.status, users.auth_version, users.password_changed_at
  FROM users
  JOIN user_role_assignments assignments ON assignments.user_id = users.id
  JOIN roles ON roles.id = assignments.role_id
  WHERE users.email = p_email;
$$;
REVOKE ALL ON FUNCTION find_user_for_login(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_for_login(citext) TO pethotel_app;

DROP FUNCTION find_user_by_id(uuid);
CREATE FUNCTION find_user_by_id(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  role text,
  status text,
  auth_version int,
  password_changed_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT users.id, users.organization_id, roles.slug, users.status,
         users.auth_version, users.password_changed_at
  FROM users
  JOIN user_role_assignments assignments ON assignments.user_id = users.id
  JOIN roles ON roles.id = assignments.role_id
  WHERE users.id = p_user_id;
$$;
REVOKE ALL ON FUNCTION find_user_by_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_id(uuid) TO pethotel_app;
