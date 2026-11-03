/**
 * Reads and writes ledger data. Every function takes a client that is already inside
 * a workspace context (withWorkspace), so row-level security applies to every query.
 */
import { Chart, type LedgerAccount, type Transaction } from '@fintrack/domain';
import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';

export type Currency = 'EUR' | 'USD';

export interface NewWorkspace {
  id: string;
  name: string;
  currency: Currency;
  timezone: string;
  ownerUserId: string;
}

/** Creates the workspace, its owner membership and its system accounts (BR-02.1). */
export async function createWorkspace(db: Db, workspace: NewWorkspace): Promise<void> {
  await db.query('INSERT INTO fin.workspaces (id, name, currency, timezone) VALUES ($1, $2, $3, $4)', [
    workspace.id,
    workspace.name,
    workspace.currency,
    workspace.timezone,
  ]);
  await db.query("INSERT INTO fin.memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [
    workspace.id,
    workspace.ownerUserId,
  ]);
  for (const code of ['OBE', 'ADJ', 'VAL', 'CNV'] as const) {
    await db.query(
      `INSERT INTO fin.ledger_accounts (id, workspace_id, kind, currency, name, system_code)
       VALUES ($1, $2, 'equity', $3, $4, $4)`,
      [uuidv7(), workspace.id, workspace.currency, code],
    );
  }
}

async function workspaceCurrency(db: Db, workspaceId: string): Promise<Currency> {
  const result = await db.query<{ currency: Currency }>('SELECT currency FROM fin.workspaces WHERE id = $1', [workspaceId]);
  const row = result.rows[0];
  if (!row) throw new Error('Workspace not found');
  return row.currency;
}

/** Inserts a user account or a category (system accounts are created with the workspace). */
export async function insertLedgerAccount(
  db: Db,
  workspaceId: string,
  account: LedgerAccount,
  options: { systemKey?: string } = {},
): Promise<void> {
  const currency = await workspaceCurrency(db, workspaceId);
  await db.query(
    `INSERT INTO fin.ledger_accounts (id, workspace_id, kind, currency, name, is_archived, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN now() END)`,
    [account.id, workspaceId, account.kind, currency, account.name, account.archived ?? false],
  );
  if (account.account) {
    const info = account.account;
    await db.query(
      `INSERT INTO fin.accounts (ledger_account_id, workspace_id, ledger_kind, account_class, account_type,
                                 spendable, card_reserve, opening_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [account.id, workspaceId, account.kind, info.class, info.type, info.spendable, info.cardReserve, info.openingDate],
    );
  } else if (account.category) {
    await db.query(
      `INSERT INTO fin.categories (ledger_account_id, workspace_id, ledger_kind, parent_id, system_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [account.id, workspaceId, account.kind, account.category.parentId ?? null, options.systemKey ?? null],
    );
  }
}

/** Saves a validated transaction with its postings and a "create" version (LR-03, LR-10). */
export async function insertTransaction(
  db: Db,
  workspaceId: string,
  tx: Transaction,
  meta: { origin: 'manual' | 'import' | 'occurrence' | 'system'; userId: string; description?: string; memo?: string },
): Promise<void> {
  const currency = await workspaceCurrency(db, workspaceId);
  await db.query(
    `INSERT INTO fin.transactions (id, workspace_id, txn_date, kind, status, origin, refund_of_id, description, memo,
                                   created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9, $9)`,
    [tx.id, workspaceId, tx.date, tx.kind, meta.origin, tx.refundOfId ?? null, meta.description ?? null, meta.memo ?? null, meta.userId],
  );
  let lineNo = 0;
  for (const posting of tx.postings) {
    lineNo += 1;
    await db.query(
      `INSERT INTO fin.postings (id, workspace_id, transaction_id, txn_date, txn_status, ledger_account_id,
                                 amount_minor, currency, line_no, mark)
       VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9)`,
      [uuidv7(), workspaceId, tx.id, tx.date, posting.ledgerAccountId, posting.amount, currency, lineNo, posting.mark ?? null],
    );
  }
  await db.query(
    `INSERT INTO fin.transaction_versions (id, workspace_id, transaction_id, version, change_type, after, changed_by)
     VALUES ($1, $2, $3, 1, 'create', $4, $5)`,
    [uuidv7(), workspaceId, tx.id, JSON.stringify(tx), meta.userId],
  );
}

interface LedgerAccountRow {
  id: string;
  kind: LedgerAccount['kind'];
  name: string;
  system_code: LedgerAccount['systemCode'] | null;
  is_archived: boolean;
  account_class: string | null;
  account_type: string | null;
  spendable: boolean | null;
  card_reserve: boolean | null;
  opening_date: string | null;
  category_id: string | null;
  parent_id: string | null;
}

/**
 * Loads every ledger account of the workspace into a domain Chart. The explicit workspace filter
 * is the application layer of isolation; row-level security is the independent second layer (FR-02).
 */
export async function loadChart(db: Db, workspaceId: string): Promise<Chart> {
  const result = await db.query<LedgerAccountRow>(`
    SELECT la.id, la.kind, la.name, la.system_code, la.is_archived,
           a.account_class, a.account_type, a.spendable, a.card_reserve, to_char(a.opening_date, 'YYYY-MM-DD') AS opening_date,
           c.ledger_account_id AS category_id, c.parent_id
      FROM fin.ledger_accounts la
      LEFT JOIN fin.accounts a ON a.ledger_account_id = la.id
      LEFT JOIN fin.categories c ON c.ledger_account_id = la.id
     WHERE la.workspace_id = $1
     ORDER BY la.id`, [workspaceId]);
  return new Chart(
    result.rows.map((row) => {
      const account: LedgerAccount = { id: row.id, kind: row.kind, name: row.name };
      if (row.is_archived) account.archived = true;
      if (row.system_code) account.systemCode = row.system_code;
      if (row.account_class && row.account_type && row.opening_date) {
        account.account = {
          class: row.account_class as NonNullable<LedgerAccount['account']>['class'],
          type: row.account_type as NonNullable<LedgerAccount['account']>['type'],
          spendable: row.spendable ?? false,
          cardReserve: row.card_reserve ?? false,
          openingDate: row.opening_date,
        };
      }
      if (row.category_id) account.category = row.parent_id ? { parentId: row.parent_id } : {};
      return account;
    }),
  );
}

interface PostingRow {
  transaction_id: string;
  txn_date: string;
  kind: Transaction['kind'];
  status: Transaction['status'];
  refund_of_id: string | null;
  ledger_account_id: string;
  amount_minor: string;
  mark: 'discount' | 'deduction' | null;
}

/** Loads every transaction of the workspace with its postings, in line order. */
export async function loadTransactions(db: Db, workspaceId: string): Promise<Transaction[]> {
  const result = await db.query<PostingRow>(`
    SELECT t.id AS transaction_id, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.kind, t.status, t.refund_of_id,
           p.ledger_account_id, p.amount_minor::text, p.mark
      FROM fin.transactions t
      JOIN fin.postings p ON p.transaction_id = t.id
     WHERE t.workspace_id = $1 AND p.workspace_id = $1
     ORDER BY t.txn_date, t.id, p.line_no`, [workspaceId]);
  const byId = new Map<string, Transaction>();
  for (const row of result.rows) {
    let tx = byId.get(row.transaction_id);
    if (!tx) {
      tx = { id: row.transaction_id, date: row.txn_date, kind: row.kind, status: row.status, postings: [] };
      if (row.refund_of_id) tx.refundOfId = row.refund_of_id;
      byId.set(row.transaction_id, tx);
    }
    const amount = Number(row.amount_minor);
    if (!Number.isSafeInteger(amount)) throw new Error(`Unsafe amount in posting: ${row.amount_minor}`);
    tx.postings.push(row.mark ? { ledgerAccountId: row.ledger_account_id, amount, mark: row.mark } : { ledgerAccountId: row.ledger_account_id, amount });
  }
  return [...byId.values()];
}
