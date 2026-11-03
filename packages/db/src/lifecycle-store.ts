/**
 * The transaction lifecycle (Stage 1 §9.3, §9.7): edit, void, trash, restore and purge.
 * Every change bumps the transaction's version, which the caller must name (optimistic
 * concurrency, AD-07), and writes a version entry with the before and after values (LR-10).
 */
import type { Transaction } from '@fintrack/domain';
import type pg from 'pg';
import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';
import {
  insertPostings,
  loadTransactionRecord,
  snapshotOf,
  type TransactionRecord,
  type TransactionSnapshot,
  type TransactionText,
} from './ledger-store.ts';

export type ChangeType = 'create' | 'edit' | 'void' | 'restore' | 'trash' | 'unlock';

/** The transaction changed since the caller read it (HTTP 409 VERSION_CONFLICT). */
export class VersionConflict extends Error {
  override name = 'VersionConflict';
}

export interface ChangeResult {
  version: number;
  versionId: string;
}

async function recordVersion(
  db: Db,
  workspaceId: string,
  change: { transactionId: string; version: number; type: ChangeType; before: unknown; after: unknown; userId: string },
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO fin.transaction_versions (id, workspace_id, transaction_id, version, change_type, before, after, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, workspaceId, change.transactionId, change.version, change.type, JSON.stringify(change.before), JSON.stringify(change.after), change.userId],
  );
  return id;
}

async function current(db: Db, workspaceId: string, id: string, expectedVersion: number): Promise<TransactionRecord> {
  const record = await loadTransactionRecord(db, workspaceId, id);
  if (!record || record.version !== expectedVersion) throw new VersionConflict('The transaction was changed by another action. Reload it and try again');
  return record;
}

/**
 * Replaces a posted transaction's postings and fields atomically (LR-10, E-38). The old postings
 * are removed before the row changes, so the database checks the new lines against the new date.
 */
export async function replaceTransaction(
  db: Db,
  workspaceId: string,
  tx: Transaction,
  options: TransactionText & { expectedVersion: number; userId: string },
): Promise<ChangeResult> {
  const before = await current(db, workspaceId, tx.id, options.expectedVersion);
  await db.query('DELETE FROM fin.postings WHERE workspace_id = $1 AND transaction_id = $2', [workspaceId, tx.id]);
  const updated = await db.query<{ version: number }>(
    `UPDATE fin.transactions
        SET txn_date = $3, kind = $4, refund_of_id = $5, description = $6, memo = $7,
            version = version + 1, updated_by = $8, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $9 AND status = 'posted'
      RETURNING version`,
    [workspaceId, tx.id, tx.date, tx.kind, tx.refundOfId ?? null, options.description, options.memo, options.userId, options.expectedVersion],
  );
  const version = updated.rows[0]?.version;
  if (version === undefined) throw new VersionConflict('Only posted transactions can be edited');
  await insertPostings(db, workspaceId, { ...tx, status: 'posted' });
  const versionId = await recordVersion(db, workspaceId, {
    transactionId: tx.id,
    version,
    type: 'edit',
    before: snapshotOf(before.tx, before),
    after: snapshotOf({ ...tx, status: 'posted' }, options),
    userId: options.userId,
  });
  return { version, versionId };
}

/**
 * Moves a transaction between Posted, Voided and Trashed (§9.3). The status is copied to its
 * postings by the cascading foreign key, so every metric excludes or includes them at once.
 */
export async function changeTransactionStatus(
  db: Db,
  workspaceId: string,
  id: string,
  change: { to: Transaction['status']; type: ChangeType; expectedVersion: number; userId: string },
): Promise<ChangeResult> {
  const before = await current(db, workspaceId, id, change.expectedVersion);
  const updated = await db.query<{ version: number }>(
    `UPDATE fin.transactions
        SET status = $3,
            voided_at = CASE WHEN $3 = 'voided' THEN now() END,
            trashed_at = CASE WHEN $3 = 'trashed' THEN now() END,
            version = version + 1, updated_by = $4, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $5
      RETURNING version`,
    [workspaceId, id, change.to, change.userId, change.expectedVersion],
  );
  const version = updated.rows[0]?.version;
  if (version === undefined) throw new VersionConflict('The transaction was changed by another action');
  const versionId = await recordVersion(db, workspaceId, {
    transactionId: id,
    version,
    type: change.type,
    before: { status: before.tx.status },
    after: { status: change.to },
    userId: change.userId,
  });
  return { version, versionId };
}

export interface VersionEntry {
  id: string;
  version: number;
  changeType: ChangeType;
  before: TransactionSnapshot | { status: Transaction['status'] } | null;
  after: TransactionSnapshot | { status: Transaction['status'] } | null;
  changedBy: string | null;
  changedAt: string;
}

const versionColumns = (v: string) => `${v}.id, ${v}.transaction_id, ${v}.version, ${v}.change_type, ${v}.before, ${v}.after,
  ${v}.changed_by, to_char(${v}.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at`;

interface VersionRow {
  id: string;
  transaction_id: string;
  version: number;
  change_type: ChangeType;
  before: VersionEntry['before'];
  after: VersionEntry['after'];
  changed_by: string | null;
  changed_at: string;
}

const toEntry = (row: VersionRow): VersionEntry => ({
  id: row.id,
  version: row.version,
  changeType: row.change_type,
  before: row.before,
  after: row.after,
  changedBy: row.changed_by,
  changedAt: row.changed_at,
});

/** A transaction's history, oldest first (FR-19). */
export async function listTransactionVersions(db: Db, workspaceId: string, transactionId: string): Promise<VersionEntry[]> {
  const result = await db.query<VersionRow>(
    `SELECT ${versionColumns('v')} FROM fin.transaction_versions v
      WHERE v.workspace_id = $1 AND v.transaction_id = $2 ORDER BY v.version`,
    [workspaceId, transactionId],
  );
  return result.rows.map(toEntry);
}

/**
 * The version entry an undo token names, if it was written by this user within `windowSeconds`
 * and is still the transaction's latest change (GAP-4). Anything else can't be undone.
 */
export async function findUndoableVersion(
  db: Db,
  workspaceId: string,
  options: { versionId: string; userId: string; windowSeconds: number },
): Promise<(VersionEntry & { transactionId: string }) | null> {
  const result = await db.query<VersionRow>(
    `SELECT ${versionColumns('v')} FROM fin.transaction_versions v
       JOIN fin.transactions t ON t.id = v.transaction_id AND t.workspace_id = v.workspace_id
      WHERE v.workspace_id = $1 AND v.id = $2 AND v.changed_by = $3
        AND v.changed_at > now() - make_interval(secs => $4)
        AND t.version = v.version`,
    [workspaceId, options.versionId, options.userId, options.windowSeconds],
  );
  const row = result.rows[0];
  return row ? { ...toEntry(row), transactionId: row.transaction_id } : null;
}

/**
 * Permanently removes transactions trashed more than `days` ago (FR-19, OD-05), across all
 * workspaces. Runs as the maintenance role, never as the application role, which can't delete.
 * Each purge leaves an audit event with IDs only; a refund of a purged original keeps its
 * amount and loses only its link (GAP-2). Expired idempotency records go too.
 */
export async function purgeExpiredTrash(pool: pg.Pool, days = 30): Promise<{ purged: number }> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const purged = await purgeInTransaction(db, days);
    await db.query('COMMIT');
    return { purged };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

async function purgeInTransaction(db: Db, days: number): Promise<number> {
  await db.query('SET LOCAL ROLE fin_maintenance');
  const candidates = await db.query<{ id: string }>(
    `SELECT id FROM fin.transactions WHERE status = 'trashed' AND trashed_at < now() - make_interval(days => $1)`,
    [days],
  );
  let purged = 0;
  for (const { id } of candidates.rows) {
    const refunds = await db.query<{ id: string }>('SELECT id FROM fin.transactions WHERE refund_of_id = $1', [id]);
    // Re-checked in the DELETE itself, so a restore that won the race is never purged.
    const deleted = await db.query<{ workspace_id: string }>(
      `DELETE FROM fin.transactions
        WHERE id = $1 AND status = 'trashed' AND trashed_at < now() - make_interval(days => $2)
        RETURNING workspace_id`,
      [id, days],
    );
    const workspaceId = deleted.rows[0]?.workspace_id;
    if (!workspaceId) continue;
    purged += 1;
    await db.query(
      `INSERT INTO fin.audit_events (id, workspace_id, event_type, object_type, object_id)
       VALUES ($1, $2, 'transaction.purged', 'transaction', $3)`,
      [uuidv7(), workspaceId, id],
    );
    for (const refund of refunds.rows) {
      await db.query(
        `INSERT INTO fin.audit_events (id, workspace_id, event_type, object_type, object_id, metadata)
         VALUES ($1, $2, 'transaction.refund_link_cleared', 'transaction', $3, $4)`,
        [uuidv7(), workspaceId, refund.id, JSON.stringify({ purgedOriginalId: id })],
      );
    }
  }
  await db.query('DELETE FROM fin.idempotency_records WHERE expires_at < now()');
  return purged;
}
