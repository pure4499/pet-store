-- Keep source-specific or ambiguous values outside core entity columns while
-- retaining enough provenance to resolve them later. Also map the imported
-- contact separately from its household account so repeated imports never need
-- to guess by name, email, or phone.

CREATE TABLE owner_external_ids (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  owner_id            uuid NOT NULL,
  import_batch_id     uuid NOT NULL,
  external_source_id  uuid NOT NULL,
  external_id         text NOT NULL,
  source_row_number   int CHECK (source_row_number IS NULL OR source_row_number > 0),
  source_checksum     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, owner_id)
    REFERENCES owners (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  UNIQUE (organization_id, external_source_id, external_id),
  UNIQUE (organization_id, owner_id, external_source_id)
);
CREATE INDEX ix_owner_external_ids_owner ON owner_external_ids (owner_id);

CREATE TABLE pet_flags (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  pet_id              uuid NOT NULL,
  flag_type           text NOT NULL CHECK (flag_type IN (
    'bite_risk',
    'dog_reactivity',
    'escape_risk',
    'muzzle_required',
    'leash_required_in_kennel',
    'visual_impairment',
    'vocal'
  )),
  note                text,
  external_source_id  uuid,
  import_batch_id     uuid,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  FOREIGN KEY (organization_id, pet_id)
    REFERENCES pets (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id),
  CHECK (active OR ended_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_pet_active_flag
  ON pet_flags (organization_id, pet_id, flag_type)
  WHERE active;

CREATE TABLE data_import_issues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  import_batch_id     uuid NOT NULL,
  source_row_number   int CHECK (source_row_number IS NULL OR source_row_number > 0),
  entity_type         text NOT NULL CHECK (entity_type IN ('household', 'owner', 'pet', 'service')),
  external_id         text,
  field_name          text NOT NULL,
  issue_code          text NOT NULL,
  raw_value           text,
  resolution_status   text NOT NULL DEFAULT 'open'
    CHECK (resolution_status IN ('open', 'resolved', 'ignored')),
  resolution_note     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id)
);
CREATE INDEX ix_data_import_issues_batch_status
  ON data_import_issues (import_batch_id, resolution_status);

ALTER TABLE household_addresses
  ADD COLUMN external_source_id uuid,
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT fk_household_addresses_source_same_org
    FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  ADD CONSTRAINT fk_household_addresses_batch_same_org
    FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id);

CREATE UNIQUE INDEX uq_household_address_source
  ON household_addresses (organization_id, household_id, external_source_id)
  WHERE external_source_id IS NOT NULL;

ALTER TABLE pet_care_providers
  ADD COLUMN external_source_id uuid,
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT fk_pet_care_providers_source_same_org
    FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  ADD CONSTRAINT fk_pet_care_providers_batch_same_org
    FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'owner_external_ids',
      'pet_flags',
      'data_import_issues'
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
  owner_external_ids,
  pet_flags,
  data_import_issues
TO pethotel_app;
