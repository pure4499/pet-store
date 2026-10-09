import { Pool, type PoolClient } from "pg";
import { config } from "../config.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

/**
 * Runs `fn` inside a transaction with `app.current_org_id` set via SET LOCAL,
 * which Postgres RLS policies (see 0001_init_core_schema.sql) filter on.
 * SET LOCAL is transaction-scoped, so this is safe under connection pooling.
 *
 * organizationId must come from the verified JWT claim, never client input.
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

/** For pre-auth operations only (login, org signup) — no org scope exists yet. */
export async function withoutOrgScope<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
