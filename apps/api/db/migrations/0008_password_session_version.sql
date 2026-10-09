-- Allow password changes to invalidate refresh tokens without storing tokens.
-- Existing refresh tokens omit auth_version and are treated as version 1.

ALTER TABLE users
  ADD COLUMN auth_version int NOT NULL DEFAULT 1
  CHECK (auth_version > 0);

DROP FUNCTION find_user_for_login(citext);
CREATE FUNCTION find_user_for_login(p_email citext)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  password_hash text,
  full_name text,
  role text,
  status text,
  auth_version int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT users.id, users.organization_id, users.password_hash, users.full_name,
         roles.slug, users.status, users.auth_version
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
  auth_version int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT users.id, users.organization_id, roles.slug, users.status,
         users.auth_version
  FROM users
  JOIN user_role_assignments assignments ON assignments.user_id = users.id
  JOIN roles ON roles.id = assignments.role_id
  WHERE users.id = p_user_id;
$$;
REVOKE ALL ON FUNCTION find_user_by_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_id(uuid) TO pethotel_app;
