/**
 * Reconciliations (FR-18). A completed reconciliation locks its transactions in the database
 * (migration 0005); unlocking marks it broken, and a later reconciliation supersedes it.
 */
import type { Db } from './context.ts';

export type ReconciliationStatus = 'completed' | 'broken' | 'superseded';

export interface ReconciliationRow {
  id: string;
  accountId: string;
  statementDate: string;
  statementBalance: number;
  status: ReconciliationStatus;
  adjustmentTransactionId: string | null;
  completedAt: string;
  unlockedAt: string | null;
  transactionIds: string[];
}

export async function insertReconciliation(
  db: Db,
  workspaceId: string,
  reconciliation: {
    id: string;
    accountId: string;
    statementDate: string;
    statementBalance: number;
    adjustmentTransactionId: string | null;
    transactionIds: readonly string[];
    userId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO fin.reconciliations (id, workspace_id, account_id, statement_date, statement_balance_minor,
                                      adjustment_transaction_id, completed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      reconciliation.id,
      workspaceId,
      reconciliation.accountId,
      reconciliation.statementDate,
      reconciliation.statementBalance,
      reconciliation.adjustmentTransactionId,
      reconciliation.userId,
    ],
  );
  await db.query(
    `INSERT INTO fin.reconciliation_items (reconciliation_id, workspace_id, transaction_id)
     SELECT $1, $2, unnest($3::uuid[])`,
    [reconciliation.id, workspaceId, [...new Set(reconciliation.transactionIds)]],
  );
}

/** A workspace's reconciliations, newest statement first, each with the transactions it covers. */
export async function listReconciliations(db: Db, workspaceId: string, accountId?: string): Promise<ReconciliationRow[]> {
  const result = await db.query<{
    id: string;
    account_id: string;
    statement_date: string;
    statement_balance_minor: string;
    status: ReconciliationStatus;
    adjustment_transaction_id: string | null;
    completed_at: string;
    unlocked_at: string | null;
    transaction_ids: string[] | null;
  }>(
    `SELECT r.id, r.account_id, to_char(r.statement_date, 'YYYY-MM-DD') AS statement_date,
            r.statement_balance_minor::text, r.status, r.adjustment_transaction_id,
            to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
            to_char(r.unlocked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS unlocked_at,
            array_agg(i.transaction_id) FILTER (WHERE i.transaction_id IS NOT NULL) AS transaction_ids
       FROM fin.reconciliations r
       LEFT JOIN fin.reconciliation_items i ON i.reconciliation_id = r.id AND i.workspace_id = $1
      WHERE r.workspace_id = $1 AND ($2::uuid IS NULL OR r.account_id = $2)
      GROUP BY r.id
      ORDER BY r.statement_date DESC, r.completed_at DESC`,
    [workspaceId, accountId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    statementDate: row.statement_date,
    statementBalance: Number(row.statement_balance_minor),
    status: row.status,
    adjustmentTransactionId: row.adjustment_transaction_id,
    completedAt: row.completed_at,
    unlockedAt: row.unlocked_at,
    transactionIds: row.transaction_ids ?? [],
  }));
}

/** Every transaction held by a completed reconciliation: these are locked (AC-18.2). */
export async function lockedTransactionIds(db: Db, workspaceId: string): Promise<Set<string>> {
  const result = await db.query<{ transaction_id: string }>(
    `SELECT DISTINCT i.transaction_id FROM fin.reconciliation_items i
       JOIN fin.reconciliations r ON r.id = i.reconciliation_id
      WHERE i.workspace_id = $1 AND r.workspace_id = $1 AND r.status = 'completed'`,
    [workspaceId],
  );
  return new Set(result.rows.map((row) => row.transaction_id));
}

/** Unlocks a completed reconciliation; it stays broken until a new one supersedes it (FR-18). */
export async function unlockReconciliation(db: Db, workspaceId: string, id: string, userId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE fin.reconciliations SET status = 'broken', unlocked_at = now(), unlocked_by = $3
      WHERE workspace_id = $1 AND id = $2 AND status = 'completed'`,
    [workspaceId, id, userId],
  );
  return result.rowCount === 1;
}

/** A new reconciliation of the account redoes every broken one up to its statement date. */
export async function supersedeBroken(db: Db, workspaceId: string, accountId: string, statementDate: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE fin.reconciliations SET status = 'superseded'
      WHERE workspace_id = $1 AND account_id = $2 AND status = 'broken' AND statement_date <= $3
      RETURNING id`,
    [workspaceId, accountId, statementDate],
  );
  return result.rows.map((row) => row.id);
}
