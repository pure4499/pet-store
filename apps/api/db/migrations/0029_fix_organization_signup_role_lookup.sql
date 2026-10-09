-- The function returns an output column named organization_id. In PL/pgSQL,
-- that output variable conflicts with an unqualified roles.organization_id
-- reference and makes new-organization signup fail with SQLSTATE 42702.
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

  SELECT role_definition.id INTO v_owner_role_id
  FROM roles AS role_definition
  WHERE role_definition.organization_id = v_org_id
    AND role_definition.slug = 'owner_admin';

  INSERT INTO users (organization_id, email, password_hash, full_name)
    VALUES (v_org_id, p_admin_email, p_admin_password_hash, p_admin_full_name)
    RETURNING id INTO v_user_id;
  INSERT INTO user_role_assignments (organization_id, user_id, role_id, assigned_by)
    VALUES (v_org_id, v_user_id, v_owner_role_id, v_user_id);

  RETURN QUERY SELECT v_org_id, v_user_id;
END;
$$;
