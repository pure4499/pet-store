-- Phase-one commerce foundation. Tail Tells owns pet/stay context and an
-- auditable charge sheet; an external provider will own card processing later.

-- Composite tenant keys let dependent commerce rows enforce that linked stays
-- and pets belong to the same organization, in addition to RLS.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_org_id ON sessions (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pets_org_id ON pets (organization_id, id);

CREATE TABLE commerce_catalog_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  item_type         text NOT NULL CHECK (item_type IN ('service', 'product')),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description       text,
  sku               text,
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  currency          char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  taxable           boolean NOT NULL DEFAULT false,
  track_inventory   boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX uq_commerce_catalog_items_active_name
  ON commerce_catalog_items (organization_id, lower(name))
  WHERE is_active;
CREATE UNIQUE INDEX uq_commerce_catalog_items_sku
  ON commerce_catalog_items (organization_id, lower(sku))
  WHERE sku IS NOT NULL AND is_active;

CREATE TABLE stay_charge_sheets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  session_id        uuid NOT NULL,
  pet_id            uuid NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'settled', 'void')),
  currency          char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  notes             text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, session_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, session_id) REFERENCES sessions(organization_id, id),
  FOREIGN KEY (organization_id, pet_id) REFERENCES pets(organization_id, id)
);

CREATE INDEX ix_stay_charge_sheets_org_status
  ON stay_charge_sheets (organization_id, status, updated_at DESC);

CREATE TABLE stay_charge_sheet_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  charge_sheet_id   uuid NOT NULL,
  catalog_item_id   uuid,
  item_type         text NOT NULL CHECK (item_type IN ('service', 'product')),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity          integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  discount_cents    integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_cents         integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  notes             text,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, charge_sheet_id) REFERENCES stay_charge_sheets(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, catalog_item_id) REFERENCES commerce_catalog_items(organization_id, id),
  CHECK (discount_cents <= unit_price_cents * quantity + tax_cents)
);

CREATE INDEX ix_stay_charge_sheet_items_sheet
  ON stay_charge_sheet_items (organization_id, charge_sheet_id, created_at);

CREATE TABLE commerce_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  charge_sheet_id   uuid NOT NULL,
  event_type        text NOT NULL,
  actor_user_id     uuid REFERENCES users(id),
  event_data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, charge_sheet_id) REFERENCES stay_charge_sheets(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_commerce_events_sheet
  ON commerce_events (organization_id, charge_sheet_id, created_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commerce_catalog_items',
    'stay_charge_sheets',
    'stay_charge_sheet_items',
    'commerce_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.current_org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  commerce_catalog_items, stay_charge_sheets, stay_charge_sheet_items
TO pethotel_app;

-- Commerce events are an audit trail. Runtime may append and inspect events,
-- but ordinary application traffic cannot rewrite or remove them.
GRANT SELECT, INSERT ON commerce_events TO pethotel_app;

COMMENT ON TABLE stay_charge_sheets IS
  'Operational stay charges only; payment provider status is deliberately separate.';
COMMENT ON COLUMN stay_charge_sheet_items.unit_price_cents IS
  'Immutable price snapshot in the charge-sheet currency, not a live catalog lookup.';
