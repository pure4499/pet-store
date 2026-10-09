-- Explicit household grouping: multiple owner contacts (e.g. different family
-- members registering pets under their own names) can be linked together so
-- their pets are treated as one family for reporting purposes, independent of
-- whether they share a phone number.
CREATE TABLE households (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_households_org ON households (organization_id);

ALTER TABLE owners ADD COLUMN household_id uuid REFERENCES households(id);
CREATE INDEX ix_owners_household ON owners (household_id);

-- Audit trail of sent daily-report emails: lets staff see "did we already
-- send today's report" instead of guessing, and avoids accidental duplicates.
CREATE TABLE household_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  household_id      uuid NOT NULL REFERENCES households(id),
  report_date       date NOT NULL,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  sent_by           uuid NOT NULL REFERENCES users(id),
  recipient_emails  text[] NOT NULL,
  pet_ids           uuid[] NOT NULL
);
CREATE INDEX ix_household_reports ON household_reports (household_id, report_date);

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON households USING (organization_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE household_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON household_reports USING (organization_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON households, household_reports TO pethotel_app;

-- 0001's "GRANT ... ON ALL TABLES IN SCHEMA public" only covered tables that
-- existed at the time it ran — it does not retroactively apply to tables
-- created later, which is exactly what just bit the two tables above (they
-- needed the explicit GRANT right before this). Fix it at the source so every
-- future migration's new tables are usable by pethotel_app automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE pethotel IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pethotel_app;
