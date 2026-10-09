-- Prepare normalized customer and pet imports without shaping core tables around
-- one vendor export. A POS customer maps to a household (the account), an owner
-- maps to a contact, and a pet remains independently related to that household's
-- contact. Source identifiers stay outside the domain records so re-imports are
-- idempotent without replacing Tail Tells UUID primary keys.

ALTER TABLE households
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive'));

ALTER TABLE pets
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'deceased', 'transferred')),
  ADD COLUMN is_mixed_breed boolean,
  ADD COLUMN size_class text
    CHECK (size_class IN ('toy', 'small', 'medium', 'large', 'giant', 'unknown')),
  ADD COLUMN reproductive_status text
    CHECK (reproductive_status IN ('intact', 'spayed', 'neutered', 'unknown')),
  ADD COLUMN date_of_birth_is_approximate boolean NOT NULL DEFAULT false,
  ADD COLUMN temperament text,
  ADD COLUMN care_notes text;

CREATE INDEX ix_households_org_status ON households (organization_id, status);
CREATE INDEX ix_pets_org_status ON pets (organization_id, status);
CREATE INDEX ix_owners_org_email_normalized
  ON owners (organization_id, lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX ix_owners_org_phone_normalized
  ON owners (organization_id, normalize_phone_digits(phone))
  WHERE phone IS NOT NULL;

-- Composite candidate keys let new relationships enforce that both sides of a
-- foreign key belong to the same tenant, rather than relying on UUID uniqueness
-- alone. They also close that gap for the existing owner-household relationship.
ALTER TABLE households ADD CONSTRAINT uq_households_org_id UNIQUE (organization_id, id);
ALTER TABLE owners ADD CONSTRAINT uq_owners_org_id UNIQUE (organization_id, id);
ALTER TABLE pets ADD CONSTRAINT uq_pets_org_id UNIQUE (organization_id, id);
ALTER TABLE users ADD CONSTRAINT uq_users_org_id UNIQUE (organization_id, id);
ALTER TABLE owners
  ADD CONSTRAINT fk_owners_household_same_org
  FOREIGN KEY (organization_id, household_id)
  REFERENCES households (organization_id, id);
ALTER TABLE pets
  ADD CONSTRAINT fk_pets_owner_same_org
  FOREIGN KEY (organization_id, owner_id)
  REFERENCES owners (organization_id, id);

CREATE TABLE external_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  source_key        text NOT NULL,
  display_name      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_key)
);

CREATE TABLE data_import_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  external_source_id  uuid NOT NULL,
  source_file_id      text,
  source_file_name    text NOT NULL,
  source_sheet_name   text,
  source_row_count    int NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  status              text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'validated', 'importing', 'completed', 'failed', 'rolled_back')),
  validation_summary  jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(validation_summary) = 'object'),
  imported_by         uuid,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  FOREIGN KEY (organization_id, imported_by)
    REFERENCES users (organization_id, id),
  UNIQUE (organization_id, id)
);
CREATE INDEX ix_data_import_batches_org_created
  ON data_import_batches (organization_id, created_at DESC);

CREATE TABLE household_external_ids (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  household_id        uuid NOT NULL,
  import_batch_id     uuid NOT NULL,
  external_source_id  uuid NOT NULL,
  external_id         text NOT NULL,
  source_row_number   int CHECK (source_row_number IS NULL OR source_row_number > 0),
  source_created_at   timestamptz,
  source_updated_at   timestamptz,
  source_created_by   text,
  source_updated_by   text,
  source_checksum     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, household_id)
    REFERENCES households (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  UNIQUE (organization_id, external_source_id, external_id),
  UNIQUE (organization_id, household_id, external_source_id)
);
CREATE INDEX ix_household_external_ids_household
  ON household_external_ids (household_id);

CREATE TABLE pet_external_ids (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  pet_id              uuid NOT NULL,
  import_batch_id     uuid NOT NULL,
  external_source_id  uuid NOT NULL,
  external_id         text NOT NULL,
  source_row_number   int CHECK (source_row_number IS NULL OR source_row_number > 0),
  source_created_at   timestamptz,
  source_updated_at   timestamptz,
  source_created_by   text,
  source_updated_by   text,
  source_checksum     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, pet_id)
    REFERENCES pets (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  UNIQUE (organization_id, external_source_id, external_id),
  UNIQUE (organization_id, pet_id, external_source_id)
);
CREATE INDEX ix_pet_external_ids_pet ON pet_external_ids (pet_id);

-- Customer classifications are rows rather than vendor-specific booleans.
CREATE TABLE household_flags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  household_id     uuid NOT NULL,
  flag_type        text NOT NULL CHECK (flag_type IN ('vip', 'alert')),
  note             text,
  external_source_id uuid,
  import_batch_id  uuid,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  FOREIGN KEY (organization_id, household_id)
    REFERENCES households (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  CHECK (active OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_household_active_flag
  ON household_flags (organization_id, household_id, flag_type)
  WHERE active;

CREATE TABLE household_addresses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  household_id     uuid NOT NULL,
  address_type     text NOT NULL DEFAULT 'home'
    CHECK (address_type IN ('home', 'mailing', 'other')),
  line1            text NOT NULL,
  line2            text,
  city             text,
  region           text,
  postal_code      text,
  country_code     text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  is_primary       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, household_id)
    REFERENCES households (organization_id, id)
);
CREATE UNIQUE INDEX uq_household_primary_address
  ON household_addresses (organization_id, household_id)
  WHERE is_primary;

CREATE TABLE owner_communication_preferences (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  owner_id           uuid NOT NULL,
  purpose            text NOT NULL
    CHECK (purpose IN ('service_reminders', 'marketing', 'service_reminders_and_marketing')),
  channel            text NOT NULL DEFAULT 'all'
    CHECK (channel IN ('all', 'email', 'sms', 'phone', 'postal')),
  preference_status  text NOT NULL
    CHECK (preference_status IN ('opted_in', 'opted_out', 'unknown')),
  external_source_id uuid,
  import_batch_id    uuid,
  source_recorded_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, owner_id)
    REFERENCES owners (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  UNIQUE (organization_id, owner_id, purpose, channel)
);

CREATE TABLE pet_identifiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  pet_id            uuid NOT NULL,
  identifier_type   text NOT NULL CHECK (identifier_type IN ('microchip', 'registration')),
  identifier_value  text NOT NULL,
  issuer            text,
  external_source_id uuid,
  import_batch_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, pet_id)
    REFERENCES pets (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  UNIQUE (organization_id, pet_id, identifier_type, identifier_value)
);
-- Non-unique until the duplicate source microchips have been reviewed.
CREATE INDEX ix_pet_identifiers_normalized
  ON pet_identifiers (
    organization_id,
    identifier_type,
    lower(regexp_replace(identifier_value, '[^[:alnum:]]', '', 'g'))
  );

CREATE TABLE care_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  provider_type     text NOT NULL CHECK (provider_type IN ('veterinarian', 'groomer', 'other')),
  name              text NOT NULL,
  phone             text,
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX ix_care_providers_normalized_name
  ON care_providers (organization_id, provider_type, lower(name));

CREATE TABLE pet_care_providers (
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  pet_id           uuid NOT NULL,
  care_provider_id uuid NOT NULL,
  relationship     text NOT NULL CHECK (relationship IN ('primary', 'secondary', 'historical')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, pet_id, care_provider_id),
  FOREIGN KEY (organization_id, pet_id)
    REFERENCES pets (organization_id, id),
  FOREIGN KEY (organization_id, care_provider_id)
    REFERENCES care_providers (organization_id, id)
);
-- The export contains only the most recent date for these categories, not
-- enough information to reconstruct full stays. Store explicitly sourced
-- history rather than inventing Tail Tells sessions.
CREATE TABLE pet_service_milestones (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  pet_id              uuid NOT NULL,
  import_batch_id     uuid NOT NULL,
  external_source_id  uuid NOT NULL,
  service_type        text NOT NULL
    CHECK (service_type IN ('grooming', 'boarding', 'daycare')),
  occurred_on         date NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, pet_id)
    REFERENCES pets (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  UNIQUE (organization_id, pet_id, service_type, occurred_on, external_source_id)
);
CREATE INDEX ix_pet_service_milestones_pet_date
  ON pet_service_milestones (pet_id, occurred_on DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'external_sources',
      'data_import_batches',
      'household_external_ids',
      'pet_external_ids',
      'household_flags',
      'household_addresses',
      'owner_communication_preferences',
      'pet_identifiers',
      'care_providers',
      'pet_care_providers',
      'pet_service_milestones'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.current_org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  external_sources,
  data_import_batches,
  household_external_ids,
  pet_external_ids,
  household_flags,
  household_addresses,
  owner_communication_preferences,
  pet_identifiers,
  care_providers,
  pet_care_providers,
  pet_service_milestones
TO pethotel_app;
