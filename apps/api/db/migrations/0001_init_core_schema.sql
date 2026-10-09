-- Foundational tenant-isolated schema: organizations, staff, owners, pets, sessions,
-- daily log, collar palette, and photo pipeline tables + row-level security.
-- Every other feature and every tenant-isolation guarantee depends on this being right first.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy name/phone search
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector, for pet_reference_embeddings / photo_detections

-- ─────────────────────────────────────────────────────────────
-- Tenancy
-- ─────────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text UNIQUE NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_settings (
  organization_id                   uuid PRIMARY KEY REFERENCES organizations(id),
  best_photo_count                  int NOT NULL DEFAULT 8 CHECK (best_photo_count BETWEEN 1 AND 50),
  match_confidence_threshold        numeric NOT NULL DEFAULT 0.65,
  low_confidence_threshold          numeric NOT NULL DEFAULT 0.40,
  collar_feature_enabled            boolean NOT NULL DEFAULT true,
  photo_retention_days_unpublished  int,
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  email            citext UNIQUE NOT NULL,
  password_hash    text NOT NULL,
  full_name        text NOT NULL,
  role             text NOT NULL CHECK (role IN ('owner_admin','manager','staff')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz
);
CREATE INDEX ix_users_org ON users (organization_id);

-- ─────────────────────────────────────────────────────────────
-- Owners & pets
-- ─────────────────────────────────────────────────────────────
CREATE TABLE owners (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  full_name        text NOT NULL,
  phone            text,
  email            text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_owners_org ON owners (organization_id);
CREATE INDEX ix_owners_search ON owners USING gin (full_name gin_trgm_ops, phone gin_trgm_ops);

CREATE TABLE pets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  owner_id          uuid REFERENCES owners(id),
  name              text NOT NULL,
  species           text NOT NULL CHECK (species IN ('dog','cat','other')),
  breed             text,
  date_of_birth     date,
  sex               text CHECK (sex IN ('male','female','unknown')),
  weight_kg         numeric,
  color_markings    text,
  medical_notes     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pets_org ON pets (organization_id);
CREATE INDEX ix_pets_search ON pets USING gin (name gin_trgm_ops);

-- Collar palette: a hotel owns a small fixed set of physical collars/colors —
-- modeled explicitly so "two active pets can't wear the same color" is enforceable.
CREATE TABLE organization_collar_palette (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  color_name       text NOT NULL,
  color_hex        text,
  is_active        boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, color_name)
);

-- ─────────────────────────────────────────────────────────────
-- Sessions (a discrete boarding/daycare stay)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  pet_id                uuid NOT NULL REFERENCES pets(id),
  session_type          text NOT NULL CHECK (session_type IN ('boarding','daycare')),
  check_in_at           timestamptz NOT NULL DEFAULT now(),
  expected_check_out_at timestamptz,
  check_out_at          timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','checked_out','cancelled')),
  checked_in_by         uuid REFERENCES users(id),
  checked_out_by        uuid REFERENCES users(id),
  notes                 text,
  collar_enabled        boolean NOT NULL DEFAULT false,
  collar_palette_id     uuid REFERENCES organization_collar_palette(id),
  collar_label          text,
  collar_assigned_at    timestamptz,
  collar_assigned_by    uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessions_org_status ON sessions (organization_id, status);
CREATE INDEX ix_sessions_pet ON sessions (pet_id, check_in_at);

-- Prevents two simultaneously-active sessions in the same org from claiming the same collar color.
CREATE UNIQUE INDEX uq_active_collar_per_org
  ON sessions (organization_id, collar_palette_id)
  WHERE status = 'active' AND collar_enabled = true AND collar_palette_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- Daily log
-- ─────────────────────────────────────────────────────────────
CREATE TABLE daily_log_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  session_id        uuid NOT NULL REFERENCES sessions(id),
  entry_type        text NOT NULL CHECK (entry_type IN ('note','feeding','medication','activity','incident','other')),
  entry_at          timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES users(id),
  title             text,
  body              text,
  structured_data   jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_logs_session ON daily_log_entries (session_id, entry_at);

-- ─────────────────────────────────────────────────────────────
-- Photos: raw asset / detected-animal-crop / curated per-pet link, kept as three
-- tables since quality + match state are meaningful per detected crop, not per image.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE photo_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  uploaded_by      uuid NOT NULL REFERENCES users(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  photo_count      int NOT NULL DEFAULT 0
);

CREATE TABLE photos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  batch_id           uuid REFERENCES photo_batches(id),
  uploaded_by        uuid NOT NULL REFERENCES users(id),
  storage_key        text NOT NULL,
  thumbnail_key      text,
  capture_at         timestamptz,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  width              int,
  height             int,
  file_size_bytes    bigint,
  processing_status  text NOT NULL DEFAULT 'uploaded'
                       CHECK (processing_status IN ('uploaded','queued','processing','processed','failed')),
  processing_error   text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_photos_org_status ON photos (organization_id, processing_status);

CREATE TABLE photo_detections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id            uuid NOT NULL REFERENCES photos(id),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  bbox_x              numeric NOT NULL,
  bbox_y              numeric NOT NULL,
  bbox_width          numeric NOT NULL,
  bbox_height         numeric NOT NULL,
  crop_storage_key    text,
  detector_confidence numeric,
  species_guess       text CHECK (species_guess IN ('dog','cat','unknown')),
  embedding           vector(512),
  quality_score       numeric,
  quality_metrics     jsonb,
  matched_pet_id      uuid REFERENCES pets(id),
  matched_session_id  uuid REFERENCES sessions(id),
  match_confidence    numeric,
  match_status        text NOT NULL DEFAULT 'pending'
                        CHECK (match_status IN ('pending','matched','low_confidence','no_match','manually_assigned','manually_rejected')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_detections_photo ON photo_detections (photo_id);
CREATE INDEX ix_detections_review_queue ON photo_detections (organization_id, match_status);

CREATE TABLE photo_pet_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  photo_id              uuid NOT NULL REFERENCES photos(id),
  pet_id                uuid NOT NULL REFERENCES pets(id),
  session_id            uuid NOT NULL REFERENCES sessions(id),
  source_detection_id   uuid REFERENCES photo_detections(id),
  association_type      text NOT NULL CHECK (association_type IN ('auto_matched','manual')),
  review_state          text NOT NULL DEFAULT 'pending'
                          CHECK (review_state IN ('pending','candidate','rejected','published')),
  quality_score         numeric,
  is_manually_adjusted  boolean NOT NULL DEFAULT false,
  published_at          timestamptz,
  published_by          uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (photo_id, pet_id)
);
CREATE INDEX ix_links_session_state ON photo_pet_links (session_id, review_state);

CREATE TABLE pet_reference_embeddings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  pet_id               uuid NOT NULL REFERENCES pets(id),
  source_type          text NOT NULL CHECK (source_type IN ('registration_photo','confirmed_session_photo')),
  source_detection_id  uuid REFERENCES photo_detections(id),
  embedding            vector(512),
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ref_embeddings_pet ON pet_reference_embeddings (pet_id) WHERE is_active;
-- Deferred until scale warrants it: exact k-NN over the few hundred rows a scoped
-- query touches is sub-millisecond without an ANN index (see plan §3).
-- CREATE INDEX ON pet_reference_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE photo_match_corrections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  photo_detection_id   uuid NOT NULL REFERENCES photo_detections(id),
  previous_pet_id      uuid REFERENCES pets(id),
  corrected_pet_id     uuid REFERENCES pets(id),
  corrected_by         uuid NOT NULL REFERENCES users(id),
  corrected_at         timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Row-level security: application-level org scoping is the primary, efficient
-- mechanism (every query below still filters by organization_id explicitly);
-- RLS is defense-in-depth for the case where a future query forgets that filter.
-- The API sets `app.current_org_id` via SET LOCAL inside each request transaction.
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'organization_settings', 'users', 'owners', 'pets',
      'organization_collar_palette', 'sessions', 'daily_log_entries',
      'photo_batches', 'photos', 'photo_detections', 'photo_pet_links',
      'pet_reference_embeddings', 'photo_match_corrections'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- A dedicated non-superuser role for the API's runtime connection pool.
-- RLS above is meaningless if the app connects as a superuser (superusers and
-- BYPASSRLS roles always skip RLS regardless of FORCE) — local dev's default
-- Postgres user is a superuser, so a distinct low-privilege role is required
-- for RLS to actually be enforced rather than silently bypassed.
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pethotel_app') THEN
    CREATE ROLE pethotel_app LOGIN PASSWORD 'pethotel_app_dev';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO pethotel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pethotel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pethotel_app;

-- Narrow, audited bypass of RLS for the one legitimate pre-auth case: looking up
-- a user by email before their organization_id is known (that's what login is).
-- Owned by the migration role (superuser in local dev, so it bypasses RLS
-- naturally); pethotel_app can only reach `users` pre-auth through this one
-- function — every other query it runs stays fully RLS-enforced.
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
  SELECT id, organization_id, password_hash, full_name, role, status
  FROM users
  WHERE email = p_email;
$$;

REVOKE ALL ON FUNCTION find_user_for_login(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_for_login(citext) TO pethotel_app;

-- Same pre-auth problem for refresh-token exchange: the request carries a user
-- id but not yet a validated organization_id to scope the lookup to.
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
  SELECT id, organization_id, role, status
  FROM users
  WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION find_user_by_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_by_id(uuid) TO pethotel_app;

-- Same problem for organization signup: creating the very first row in a brand
-- new organization happens before that organization has any context to scope
-- to. Narrow SECURITY DEFINER path, mirroring find_user_for_login above.
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
BEGIN
  INSERT INTO organizations (name, slug) VALUES (p_org_name, p_org_slug) RETURNING id INTO v_org_id;
  INSERT INTO organization_settings (organization_id) VALUES (v_org_id);
  INSERT INTO users (organization_id, email, password_hash, full_name, role)
    VALUES (v_org_id, p_admin_email, p_admin_password_hash, p_admin_full_name, 'owner_admin')
    RETURNING id INTO v_user_id;
  RETURN QUERY SELECT v_org_id, v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION create_organization_with_admin(text, text, citext, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_organization_with_admin(text, text, citext, text, text) TO pethotel_app;

-- The worker has the same pre-scope problem: it must discover newly-uploaded
-- photos across ALL tenants before it knows which organization to scope to
-- (mirroring how SQS's ReceiveMessage in production has no notion of tenant
-- either — it's broker-level, not application-level). This is local dev's
-- stand-in for that broker (see apps/worker/src/queue/photoQueue.ts); it
-- atomically claims a batch of rows so two worker instances can't double-process
-- the same photo, and returns just enough (id/org id/storage key) to let the
-- worker then do everything else org-scoped like any other query.
CREATE OR REPLACE FUNCTION claim_next_uploaded_photos(p_limit int)
RETURNS TABLE (id uuid, organization_id uuid, storage_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE photos
  SET processing_status = 'processing'
  WHERE id IN (
    SELECT ph.id FROM photos ph
    WHERE ph.processing_status = 'uploaded'
    ORDER BY ph.uploaded_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING photos.id, photos.organization_id, photos.storage_key;
$$;

REVOKE ALL ON FUNCTION claim_next_uploaded_photos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_uploaded_photos(int) TO pethotel_app;
