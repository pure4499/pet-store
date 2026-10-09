-- Shareable owner report links. The UUID carries 122 random bits and is the
-- bearer credential; public resolution returns only already-published reports.
ALTER TABLE report_video_drafts
  ADD COLUMN public_share_token uuid,
  ADD COLUMN share_created_at timestamptz,
  ADD COLUMN last_emailed_at timestamptz;

CREATE UNIQUE INDEX ux_report_video_drafts_public_share_token
  ON report_video_drafts (public_share_token)
  WHERE public_share_token IS NOT NULL;

UPDATE report_video_drafts
SET public_share_token = gen_random_uuid(),
    share_created_at = COALESCE(published_at, now())
WHERE status = 'published' AND public_share_token IS NULL;

CREATE TABLE report_share_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  report_video_id   uuid NOT NULL REFERENCES report_video_drafts(id),
  channel           text NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient         text NOT NULL,
  sent_by           uuid NOT NULL REFERENCES users(id),
  sent_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_report_share_deliveries_report
  ON report_share_deliveries (report_video_id, sent_at DESC);

ALTER TABLE report_share_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_share_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_share_deliveries
  USING (organization_id = current_setting('app.current_org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON report_share_deliveries TO pethotel_app;

-- Public requests have no organization claim. Resolve only the opaque token to
-- its tenant and report, then perform every content query under withOrgScope.
CREATE OR REPLACE FUNCTION resolve_public_report_share(p_token uuid)
RETURNS TABLE (organization_id uuid, report_video_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT r.organization_id, r.id
  FROM report_video_drafts r
  WHERE r.public_share_token = p_token
    AND r.status = 'published'
    AND r.published_at IS NOT NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_public_report_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_public_report_share(uuid) TO pethotel_app;
