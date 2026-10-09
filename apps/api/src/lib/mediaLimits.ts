import type { PoolClient } from "pg";

export const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_PHOTOS_PER_BATCH = 50;

export async function currentSourceMediaBytes(
  client: PoolClient,
  organizationId: string,
) {
  const result = await client.query(
    `SELECT (
       COALESCE((SELECT sum(file_size_bytes) FROM photos WHERE organization_id = $1), 0)
       + COALESCE((SELECT sum(file_size_bytes) FROM videos WHERE organization_id = $1), 0)
     )::text AS bytes`,
    [organizationId],
  );
  return Number((result.rows[0] as { bytes?: string } | undefined)?.bytes ?? 0);
}
