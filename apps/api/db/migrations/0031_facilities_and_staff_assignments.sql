-- Model physical operating locations separately from the organization tenant.
-- Existing organizations, users, and stays are preserved under one default
-- location; staff may then be assigned to one or many locations.

CREATE TABLE facilities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  is_default       boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name)
);

CREATE UNIQUE INDEX uq_facilities_default_per_org
  ON facilities (organization_id)
  WHERE is_default = true;

CREATE TABLE user_facility_assignments (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id      uuid NOT NULL,
  assigned_by      uuid REFERENCES users(id),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, facility_id),
  FOREIGN KEY (organization_id, facility_id)
    REFERENCES facilities(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_user_facility_assignments_org_facility
  ON user_facility_assignments (organization_id, facility_id);

INSERT INTO facilities (organization_id, name, is_default)
SELECT id, name, true
FROM organizations;

INSERT INTO user_facility_assignments (organization_id, user_id, facility_id, assigned_by)
SELECT users.organization_id, users.id, facilities.id, users.id
FROM users
JOIN facilities
  ON facilities.organization_id = users.organization_id
 AND facilities.is_default = true;

ALTER TABLE sessions ADD COLUMN facility_id uuid;

UPDATE sessions
SET facility_id = facilities.id
FROM facilities
WHERE facilities.organization_id = sessions.organization_id
  AND facilities.is_default = true;

ALTER TABLE sessions
  ALTER COLUMN facility_id SET NOT NULL,
  ADD CONSTRAINT fk_sessions_facility
    FOREIGN KEY (organization_id, facility_id)
    REFERENCES facilities(organization_id, id) ON DELETE RESTRICT;

CREATE INDEX ix_sessions_org_facility_status
  ON sessions (organization_id, facility_id, status);

CREATE OR REPLACE FUNCTION seed_default_facility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO facilities (organization_id, name, is_default)
  VALUES (NEW.id, NEW.name, true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_default_facility ON organizations;
CREATE TRIGGER trg_seed_default_facility
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION seed_default_facility();

CREATE OR REPLACE FUNCTION assign_new_user_default_facility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO user_facility_assignments (organization_id, user_id, facility_id, assigned_by)
  SELECT NEW.organization_id, NEW.id, facilities.id, NEW.id
  FROM facilities
  WHERE facilities.organization_id = NEW.organization_id
    AND facilities.is_default = true
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_new_user_default_facility ON users;
CREATE TRIGGER trg_assign_new_user_default_facility
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION assign_new_user_default_facility();

ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON facilities
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE user_facility_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_facility_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_facility_assignments
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON facilities, user_facility_assignments TO pethotel_app;
