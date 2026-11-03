/**
 * Every database transaction that touches financial data runs inside a workspace context
 * (Stage 2 §8.3): the application role is assumed, the workspace and user are set for
 * row-level security, and writes take the per-workspace lock (AD-07).
 */
import type pg from 'pg';

export interface RequestContext {
  workspaceId: string;
  userId: string;
}

export type Db = pg.PoolClient;

export interface ContextOptions {
  /** Serialize writes within the workspace (AD-07). Reads don't need it. */
  write?: boolean;
}

/**
 * A context with only the user set, for the few queries that run before a workspace is chosen
 * (finding the user's memberships). Row-level security still applies.
 */
export async function withUser<T>(pool: pg.Pool, userId: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE fin_app');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withWorkspace<T>(
  pool: pg.Pool,
  context: RequestContext,
  work: (db: Db) => Promise<T>,
  options: ContextOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE fin_app');
    await client.query("SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)", [
      context.workspaceId,
      context.userId,
    ]);
    if (options.write) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace:' || $1, 0))", [context.workspaceId]);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
