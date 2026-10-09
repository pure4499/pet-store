import { pool, withOrgScope } from "../db/pool.js";

export interface ClaimedIdentityVideo {
  id: string;
  organizationId: string;
  storageKey: string;
}

export class PollingIdentityVideoQueue {
  async poll(limit: number): Promise<ClaimedIdentityVideo[]> {
    const result = await pool.query("SELECT * FROM claim_next_identity_videos($1)", [limit]);
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      storageKey: row.storage_key,
    }));
  }

  async reportFailure(video: ClaimedIdentityVideo, error: unknown): Promise<void> {
    await withOrgScope(video.organizationId, (client) =>
      client.query(
        `UPDATE videos SET processing_status = 'failed', processing_error = $1
         WHERE id = $2 AND organization_id = $3`,
        [error instanceof Error ? error.message : String(error), video.id, video.organizationId]
      )
    );
  }
}
