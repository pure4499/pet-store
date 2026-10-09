-- Short report-video workflow: staff-uploaded clips, per-pet review links, and
-- asynchronous 10-15 second video drafts that require administrator approval.

CREATE TABLE videos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  uploaded_by        uuid NOT NULL REFERENCES users(id),
  storage_key        text NOT NULL,
  capture_at         timestamptz,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  duration_seconds   numeric,
  width              int,
  height             int,
  file_size_bytes    bigint,
  content_type       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_videos_org_uploaded ON videos (organization_id, uploaded_at DESC);

CREATE TABLE video_pet_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  video_id               uuid NOT NULL REFERENCES videos(id),
  pet_id                 uuid NOT NULL REFERENCES pets(id),
  session_id             uuid NOT NULL REFERENCES sessions(id),
  association_type       text NOT NULL DEFAULT 'manual'
                           CHECK (association_type IN ('auto_matched','manual')),
  review_state           text NOT NULL DEFAULT 'candidate'
                           CHECK (review_state IN ('candidate','rejected','published')),
  is_manually_adjusted   boolean NOT NULL DEFAULT true,
  published_at           timestamptz,
  published_by           uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, pet_id)
);
CREATE INDEX ix_video_links_session_state ON video_pet_links (session_id, review_state);

CREATE TABLE report_video_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  session_id          uuid NOT NULL REFERENCES sessions(id),
  pet_id              uuid NOT NULL REFERENCES pets(id),
  report_date         date NOT NULL,
  template            text NOT NULL DEFAULT 'daily_highlight_vertical',
  title               text NOT NULL,
  closing_caption     text,
  target_seconds      int NOT NULL DEFAULT 15 CHECK (target_seconds BETWEEN 10 AND 15),
  actual_seconds      numeric,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','rendering','ready','failed','approved','published')),
  output_storage_key  text,
  render_error        text,
  requested_by        uuid NOT NULL REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  published_by        uuid REFERENCES users(id),
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_report_video_drafts_session ON report_video_drafts (session_id, report_date DESC);
CREATE INDEX ix_report_video_drafts_queue ON report_video_drafts (status, created_at) WHERE status = 'queued';

CREATE TABLE report_video_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  report_video_id   uuid NOT NULL REFERENCES report_video_drafts(id) ON DELETE CASCADE,
  item_type         text NOT NULL CHECK (item_type IN ('photo','video','log')),
  photo_id          uuid REFERENCES photos(id),
  video_id          uuid REFERENCES videos(id),
  log_entry_id      uuid REFERENCES daily_log_entries(id),
  sort_order        int NOT NULL,
  caption           text,
  UNIQUE (report_video_id, sort_order),
  CHECK (
    (item_type = 'photo' AND photo_id IS NOT NULL AND video_id IS NULL AND log_entry_id IS NULL) OR
    (item_type = 'video' AND video_id IS NOT NULL AND photo_id IS NULL AND log_entry_id IS NULL) OR
    (item_type = 'log' AND log_entry_id IS NOT NULL AND photo_id IS NULL AND video_id IS NULL)
  )
);
CREATE INDEX ix_report_video_items_draft ON report_video_items (report_video_id, sort_order);

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['videos', 'video_pet_links', 'report_video_drafts', 'report_video_items'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON videos, video_pet_links, report_video_drafts, report_video_items TO pethotel_app;

-- Local development queue adapter. Production can replace this function with
-- a Cloud Run Job / SQS-triggered adapter without changing the renderer.
CREATE OR REPLACE FUNCTION claim_next_report_video_drafts(p_limit int)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE report_video_drafts
  SET status = 'rendering', render_error = NULL, updated_at = now()
  WHERE id IN (
    SELECT d.id FROM report_video_drafts d
    WHERE d.status = 'queued'
    ORDER BY d.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING report_video_drafts.id, report_video_drafts.organization_id;
$$;

REVOKE ALL ON FUNCTION claim_next_report_video_drafts(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_next_report_video_drafts(int) TO pethotel_app;
