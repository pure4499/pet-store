import { Pool, type PoolClient } from "pg";
import { config } from "../config.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Same RLS-scoping pattern as apps/api/src/db/pool.ts: the worker discovers a
 * photo's organization_id from the (unscoped, id-keyed) `photos` row, then
 * scopes every subsequent write for that job to that org via SET LOCAL.
 */
export async function withOrgScope<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
