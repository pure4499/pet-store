-- Source exports may contain several independently authored notes for one pet.
-- Keep authorship/purpose as rows instead of concatenating unrelated text into
-- a scalar profile column.

CREATE TABLE pet_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  pet_id              uuid NOT NULL,
  note_type           text NOT NULL CHECK (note_type IN ('internal', 'customer_provided')),
  body                text NOT NULL,
  external_source_id  uuid,
  import_batch_id     uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, pet_id)
    REFERENCES pets (organization_id, id),
  FOREIGN KEY (organization_id, external_source_id)
    REFERENCES external_sources (organization_id, id),
  FOREIGN KEY (organization_id, import_batch_id)
    REFERENCES data_import_batches (organization_id, id)
);

CREATE UNIQUE INDEX uq_pet_note_source_type
  ON pet_notes (organization_id, pet_id, external_source_id, note_type)
  WHERE external_source_id IS NOT NULL;

ALTER TABLE pet_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pet_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pet_notes
  USING (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON pet_notes TO pethotel_app;
