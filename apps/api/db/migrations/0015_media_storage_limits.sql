-- A tenant-level source-media allowance gives the application a stable unit
-- for usage visibility and upload guardrails. Object-store lifecycle rules
-- remain responsible for physically expiring retained objects.

ALTER TABLE organization_settings
  ADD COLUMN media_storage_limit_bytes bigint NOT NULL DEFAULT 5368709120
    CHECK (media_storage_limit_bytes > 0);

