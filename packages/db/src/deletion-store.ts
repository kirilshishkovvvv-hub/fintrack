/**
 * Account deletion (Stage 2 §8.6, GAP-5, OD-07): a request starts a cancel window; afterwards
 * the purge removes every row of the workspace and then the login. What stays is the audit
 * trail: IDs and event types only, whose user ID no longer leads to anyone.
 */
import type pg from 'pg';
import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';

/** GAP-5: 7 days to change one's mind. */
export const DELETION_WINDOW_DAYS = 7;

export async function setDeletionPending(db: Db, workspaceId: string, pending: boolean): Promise<void> {
  await db.query(
    `UPDATE fin.workspaces
        SET status = CASE WHEN $2 THEN 'deletion_pending' ELSE 'active' END,
            deletion_requested_at = CASE WHEN $2 THEN now() END,
            version = version + 1, updated_at = now()
      WHERE id = $1`,
    [workspaceId, pending],
  );
}

/** Deletes one workspace's rows in foreign-key order. Transactions take postings, versions and reconciliation items with them. */
async function purgeWorkspace(db: Db, workspaceId: string): Promise<void> {
  const members = await db.query<{ user_id: string }>('SELECT user_id FROM fin.memberships WHERE workspace_id = $1', [workspaceId]);
  for (const table of ['payees', 'idempotency_records', 'transactions', 'reconciliations', 'accounts', 'categories', 'ledger_accounts', 'memberships']) {
    await db.query(`DELETE FROM fin.${table} WHERE workspace_id = $1`, [workspaceId]);
  }
  for (const { user_id: userId } of members.rows) {
    await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await db.query('DELETE FROM fin.consent_records WHERE user_id = $1', [userId]);
    // Sessions, passwords and 2FA secrets go with the user (cascading foreign keys).
    await db.query('DELETE FROM auth."user" WHERE id = $1', [userId]);
  }
  // The row stays only so that the audit trail keeps its reference; nothing in it identifies anyone.
  await db.query(
    `UPDATE fin.workspaces SET name = 'deleted', timezone = 'UTC', protected_reserve_minor = 0, status = 'purged', updated_at = now() WHERE id = $1`,
    [workspaceId],
  );
  await db.query(
    `INSERT INTO fin.audit_events (id, workspace_id, event_type, object_type, object_id) VALUES ($1, $2, 'account.purged', 'workspace', $2)`,
    [uuidv7(), workspaceId],
  );
}

/**
 * Purges every workspace whose cancel window has ended, each in its own database transaction,
 * as the maintenance role. It takes the workspace lock and checks again, so a cancel that
 * arrives at the last moment wins or loses cleanly.
 */
export async function purgeDeletedWorkspaces(pool: pg.Pool, days = DELETION_WINDOW_DAYS): Promise<{ purged: number }> {
  const db = await pool.connect();
  const expired = `status = 'deletion_pending' AND deletion_requested_at < now() - make_interval(days => $1)`;
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE fin_maintenance');
    const due = await db.query<{ id: string }>(`SELECT id FROM fin.workspaces WHERE ${expired}`, [days]);
    await db.query('COMMIT');
    let purged = 0;
    for (const { id } of due.rows) {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE fin_maintenance');
        await db.query("SELECT set_config('app.workspace_id', $1, true)", [id]);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace:' || $1, 0))", [id]);
        const still = await db.query(`SELECT 1 FROM fin.workspaces WHERE id = $2 AND ${expired}`, [days, id]);
        if (still.rowCount === 1) {
          await purgeWorkspace(db, id);
          purged += 1;
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    return { purged };
  } finally {
    db.release();
  }
}
