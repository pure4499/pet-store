import { pool, withOrgScope } from "../db/pool.js";

export interface ClaimedPhoto {
  id: string;
  organizationId: string;
  storageKey: string;
}

export interface PhotoQueue {
  /** Claim up to `limit` photos ready for processing. */
  poll(limit: number): Promise<ClaimedPhoto[]>;
  /** Called once a claimed photo has failed processing (for retry/DLQ bookkeeping). */
  reportFailure(photo: ClaimedPhoto, error: unknown): Promise<void>;
}

/**
 * Local-dev stand-in for the production trigger (S3 ObjectCreated -> SQS).
 * Polls Postgres directly via the claim_next_uploaded_photos() SECURITY DEFINER
 * function (see 0001_init_core_schema.sql) instead of long-polling a real queue,
 * so the pipeline is runnable with no AWS account. A production PhotoQueue
 * implementation would long-poll SQS instead — everything downstream of
 * poll()'s return value (the pipeline in pipeline/processPhoto.ts) is identical
 * either way, which is the point of the interface.
 */
export class PollingPhotoQueue implements PhotoQueue {
  async poll(limit: number): Promise<ClaimedPhoto[]> {
    const result = await pool.query("SELECT * FROM claim_next_uploaded_photos($1)", [limit]);
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      storageKey: row.storage_key,
    }));
  }

  async reportFailure(photo: ClaimedPhoto, error: unknown): Promise<void> {
    await withOrgScope(photo.organizationId, (client) =>
      client.query(
        "UPDATE photos SET processing_status = 'failed', processing_error = $1 WHERE id = $2",
        [error instanceof Error ? error.message : String(error), photo.id]
      )
    );
  }
}
