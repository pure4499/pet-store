import { pool, withOrgScope } from "../db/pool.js";

export interface ClaimedReportVideo {
  id: string;
  organizationId: string;
}

export class PollingReportVideoQueue {
  async poll(limit: number): Promise<ClaimedReportVideo[]> {
    const result = await pool.query("SELECT * FROM claim_next_report_video_drafts($1)", [limit]);
    return result.rows.map((row) => ({ id: row.id, organizationId: row.organization_id }));
  }

  async reportFailure(job: ClaimedReportVideo, error: unknown): Promise<void> {
    await withOrgScope(job.organizationId, (client) =>
      client.query(
        `UPDATE report_video_drafts
         SET status = 'failed', render_error = $1, updated_at = now()
         WHERE id = $2 AND organization_id = $3`,
        [error instanceof Error ? error.message : String(error), job.id, job.organizationId]
      )
    );
  }
}
