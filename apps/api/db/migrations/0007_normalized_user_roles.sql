-- Normalize authorization roles out of users so role definitions and user
-- assignments can be managed independently while preserving the existing
-- owner_admin / manager / staff authorization contract.

CREATE TABLE roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug             text NOT NULL CHECK (slug IN ('owner_admin','manager','staff')),
  display_name     text NOT NULL,
  description      text NOT NULL,
  priority         int NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id)
);

CREATE TABLE user_role_assignments (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id          uuid NOT NULL,
  assigned_by      uuid REFERENCES users(id),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, role_id)
    REFERENCES roles(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX ix_user_role_assignments_org_role
  ON user_role_assignments (organization_id, role_id);

INSERT INTO roles (organization_id, slug, display_name, description, priority)
SELECT organization_id, definition.slug, definition.display_name, definition.description, definition.priority
FROM (SELECT id AS organization_id FROM organizations) organizations
CROSS JOIN (VALUES
  ('owner_admin', 'Owner administrator', 'Full access, including users and role assignments.', 100),
  ('manager', 'Manager', 'Manage check-ins, media review, reports, and publishing.', 50),
  ('staff', 'Staff', 'Use the staff workflow for active stays and media capture.', 10)
) AS definition(slug, display_name, description, priority);

INSERT INTO user_role_assignments (organization_id, user_id, role_id, assigned_by)
SELECT users.organization_id, users.id, roles.id, users.id
FROM users
JOIN roles
  ON roles.organization_id = users.organization_id
 AND roles.slug = users.role;

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE user_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_role_assignments
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON roles, user_role_assignments TO pethotel_app;

CREATE OR REPLACE FUNCTION find_user_for_login(p_email citext)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  password_hash text,
  full_name text,
  role text,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT users.id, users.organization_id, users.password_hash, users.full_name,
         roles.slug, users.status
  FROM users
  JOIN user_role_assignments assignments ON assignments.user_id = users.id
  JOIN roles ON roles.id = assignments.role_id
  WHERE users.email = p_email;
$$;

CREATE OR REPLACE FUNCTION find_user_by_id(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  role text,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT users.id, users.organization_id, roles.slug, users.status
  FROM users
  JOIN user_role_assignments assignments ON assignments.user_id = users.id
  JOIN roles ON roles.id = assignments.role_id
  WHERE users.id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION create_organization_with_admin(
  p_org_name text,
  p_org_slug text,
  p_admin_email citext,
  p_admin_password_hash text,
  p_admin_full_name text
)
RETURNS TABLE (organization_id uuid, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_user_id uuid;
  v_owner_role_id uuid;
BEGIN
  INSERT INTO organizations (name, slug)
    VALUES (p_org_name, p_org_slug)
    RETURNING id INTO v_org_id;
  INSERT INTO organization_settings (organization_id) VALUES (v_org_id);

  INSERT INTO roles (organization_id, slug, display_name, description, priority)
  VALUES
    (v_org_id, 'owner_admin', 'Owner administrator', 'Full access, including users and role assignments.', 100),
    (v_org_id, 'manager', 'Manager', 'Manage check-ins, media review, reports, and publishing.', 50),
    (v_org_id, 'staff', 'Staff', 'Use the staff workflow for active stays and media capture.', 10);

  SELECT id INTO v_owner_role_id
  FROM roles
  WHERE organization_id = v_org_id AND slug = 'owner_admin';

  INSERT INTO users (organization_id, email, password_hash, full_name)
    VALUES (v_org_id, p_admin_email, p_admin_password_hash, p_admin_full_name)
    RETURNING id INTO v_user_id;
  INSERT INTO user_role_assignments (organization_id, user_id, role_id, assigned_by)
    VALUES (v_org_id, v_user_id, v_owner_role_id, v_user_id);

  RETURN QUERY SELECT v_org_id, v_user_id;
END;
$$;

ALTER TABLE users DROP COLUMN role;
