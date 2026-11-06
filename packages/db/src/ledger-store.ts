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
                                 spendable, card_reserve, opening_date, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM fin.accounts WHERE workspace_id = $2))`,
      [account.id, workspaceId, account.kind, info.class, info.type, info.spendable, info.cardReserve, info.openingDate],
    );
  } else if (account.category) {
    await db.query(
      `INSERT INTO fin.categories (ledger_account_id, workspace_id, ledger_kind, parent_id, system_key, sort_order)
       VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM fin.categories WHERE workspace_id = $2))`,
      [account.id, workspaceId, account.kind, account.category.parentId ?? null, options.systemKey ?? null],
    );
  }
}

export type TransactionOrigin = 'manual' | 'import' | 'occurrence' | 'system';

/** Descriptive fields kept beside the postings; they never affect a figure. */
export interface TransactionText {
  description: string | null;
  memo: string | null;
  payeeId?: string | null;
}

/** What a version entry stores as its "before" and "after" values (LR-10, AC-19.2). */
export interface TransactionSnapshot extends TransactionText {
  date: string;
  kind: Transaction['kind'];
  status: Transaction['status'];
  refundOfId: string | null;
  postings: Transaction['postings'];
}

export function snapshotOf(tx: Transaction, text: TransactionText): TransactionSnapshot {
  return {
    date: tx.date,
    kind: tx.kind,
    status: tx.status,
    refundOfId: tx.refundOfId ?? null,
    postings: tx.postings,
    description: text.description,
    memo: text.memo,
    payeeId: text.payeeId ?? null,
  };
}

/** Archives or unarchives an account or category (E-58, E-59). History stays; LR-14 then blocks new postings. */
export async function setArchived(db: Db, workspaceId: string, ledgerAccountId: string, archived: boolean): Promise<void> {
  await db.query(
    `UPDATE fin.ledger_accounts
        SET is_archived = $3, archived_at = CASE WHEN $3 THEN now() END, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, ledgerAccountId, archived],
  );
}

/**
 * Merges category `fromId` into `intoId` (E-59, GT-45): every posting is re-pointed with its
 * amount unchanged, then `fromId` is archived. Returns how many postings moved.
 */
export async function mergeCategory(db: Db, workspaceId: string, fromId: string, intoId: string): Promise<number> {
  const moved = await db.query('UPDATE fin.postings SET ledger_account_id = $3 WHERE workspace_id = $1 AND ledger_account_id = $2', [
    workspaceId,
    fromId,
    intoId,
  ]);
  await setArchived(db, workspaceId, fromId, true);
  return moved.rowCount ?? 0;
}

/** Saves a validated transaction with its postings and a "create" version (LR-03, LR-10). */
export async function insertTransaction(
  db: Db,
  workspaceId: string,
  tx: Transaction,
  meta: { origin: TransactionOrigin; userId: string; description?: string; memo?: string; payeeId?: string | null },
): Promise<{ versionId: string }> {
  const text = { description: meta.description ?? null, memo: meta.memo ?? null, payeeId: meta.payeeId ?? null };
  await db.query(
    `INSERT INTO fin.transactions (id, workspace_id, txn_date, kind, status, origin, refund_of_id, description, memo,
                                   payee_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9, $10, $10)`,
    [tx.id, workspaceId, tx.date, tx.kind, meta.origin, tx.refundOfId ?? null, text.description, text.memo, text.payeeId, meta.userId],
  );
  await insertPostings(db, workspaceId, tx);
  const versionId = uuidv7();
  await db.query(
    `INSERT INTO fin.transaction_versions (id, workspace_id, transaction_id, version, change_type, after, changed_by)
     VALUES ($1, $2, $3, 1, 'create', $4, $5)`,
    [versionId, workspaceId, tx.id, JSON.stringify(snapshotOf(tx, text)), meta.userId],
  );
  return { versionId };
}

/**
 * Saves many validated transactions, in one statement per table, so that a large import stays
 * within NFR-03. The same rows as insertTransaction; the database still checks each one at commit.
 */
export async function insertTransactionsBulk(
  db: Db,
  workspaceId: string,
  items: readonly { tx: Transaction; description: string | null; payeeId?: string | null }[],
  meta: { origin: TransactionOrigin; userId: string },
): Promise<void> {
  if (items.length === 0) return;
  const currency = await workspaceCurrency(db, workspaceId);
  await db.query(
    `INSERT INTO fin.transactions (id, workspace_id, txn_date, kind, status, origin, refund_of_id, description, payee_id, created_by, updated_by)
     SELECT x.id, $1, x.txn_date, x.kind, 'posted', $2, x.refund_of_id, x.description, x.payee_id, $3, $3
       FROM jsonb_to_recordset($4::jsonb) AS x(id uuid, txn_date date, kind text, refund_of_id uuid, description text, payee_id uuid)`,
    [workspaceId, meta.origin, meta.userId, JSON.stringify(items.map(({ tx, description, payeeId }) => ({ id: tx.id, txn_date: tx.date, kind: tx.kind, refund_of_id: tx.refundOfId ?? null, description, payee_id: payeeId ?? null })))],
  );
  await db.query(
    `INSERT INTO fin.postings (id, workspace_id, transaction_id, txn_date, txn_status, ledger_account_id, amount_minor, currency, line_no, mark)
     SELECT x.id, $1, x.transaction_id, x.txn_date, 'posted', x.ledger_account_id, x.amount_minor, $2, x.line_no, x.mark
       FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, transaction_id uuid, txn_date date, ledger_account_id uuid, amount_minor bigint, line_no int, mark text)`,
    [
      workspaceId,
      currency,
      JSON.stringify(
        items.flatMap(({ tx }) =>
          tx.postings.map((posting, index) => ({
            id: uuidv7(),
            transaction_id: tx.id,
            txn_date: tx.date,
            ledger_account_id: posting.ledgerAccountId,
            amount_minor: posting.amount,
            line_no: index + 1,
            mark: posting.mark ?? null,
          })),
        ),
      ),
    ],
  );
  await db.query(
    `INSERT INTO fin.transaction_versions (id, workspace_id, transaction_id, version, change_type, after, changed_by)
     SELECT x.id, $1, x.transaction_id, 1, 'create', x.after, $2
       FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, transaction_id uuid, after jsonb)`,
    [workspaceId, meta.userId, JSON.stringify(items.map(({ tx, description }) => ({ id: uuidv7(), transaction_id: tx.id, after: snapshotOf(tx, { description, memo: null }) })))],
  );
}

/** Writes a transaction's postings in line order. Balancing is checked at commit (LR-01). */
export async function insertPostings(db: Db, workspaceId: string, tx: Transaction): Promise<void> {
  const currency = await workspaceCurrency(db, workspaceId);
  let lineNo = 0;
  for (const posting of tx.postings) {
    lineNo += 1;
    await db.query(
      `INSERT INTO fin.postings (id, workspace_id, transaction_id, txn_date, txn_status, ledger_account_id,
                                 amount_minor, currency, line_no, mark, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [uuidv7(), workspaceId, tx.id, tx.date, tx.status, posting.ledgerAccountId, posting.amount, currency, lineNo, posting.mark ?? null, posting.memo ?? null],
    );
  }
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
  origin: TransactionOrigin;
  description: string | null;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  version: number;
  trashed_at: string | null;
  ledger_account_id: string;
  amount_minor: string;
  mark: 'discount' | 'deduction' | null;
  line_memo: string | null;
}

/** A transaction as stored: the domain transaction plus its text, origin and version. */
export interface TransactionRecord extends TransactionText {
  tx: Transaction;
  origin: TransactionOrigin;
  payeeName?: string | null;
  version: number;
  trashedAt: string | null;
}

export interface RecordFilter {
  id?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  kind?: string | undefined;
  origin?: string | undefined;
  payeeId?: string | undefined;
  status?: Transaction['status'] | undefined;
  excludeStatus?: Transaction['status'] | undefined;
  /** Only transactions with a posting to one of these ledger accounts. */
  touching?: readonly string[] | undefined;
}

/** Loads the workspace's transactions with their postings in line order, narrowed by the filter in SQL. */
export async function loadTransactionRecords(db: Db, workspaceId: string, filter: RecordFilter | string = {}): Promise<TransactionRecord[]> {
  const only: RecordFilter = typeof filter === 'string' ? { id: filter } : filter;
  const result = await db.query<PostingRow>(`
    SELECT t.id AS transaction_id, to_char(t.txn_date, 'YYYY-MM-DD') AS txn_date, t.kind, t.status, t.refund_of_id,
           t.origin, t.description, t.memo, t.payee_id, pa.name AS payee_name, t.version, t.trashed_at::text,
           p.ledger_account_id, p.amount_minor::text, p.mark, p.memo AS line_memo
      FROM fin.transactions t
      JOIN fin.postings p ON p.transaction_id = t.id
      LEFT JOIN fin.payees pa ON pa.id = t.payee_id AND pa.workspace_id = t.workspace_id
     WHERE t.workspace_id = $1 AND p.workspace_id = $1 AND ($2::uuid IS NULL OR t.id = $2)
       AND ($3::date IS NULL OR t.txn_date >= $3) AND ($4::date IS NULL OR t.txn_date <= $4)
       AND ($5::text IS NULL OR t.kind = $5) AND ($6::text IS NULL OR t.origin = $6)
       AND ($7::uuid IS NULL OR t.payee_id = $7)
       AND ($8::text IS NULL OR t.status = $8) AND ($9::text IS NULL OR t.status <> $9)
       AND ($10::uuid[] IS NULL OR EXISTS (
             SELECT 1 FROM fin.postings x
              WHERE x.transaction_id = t.id AND x.workspace_id = $1 AND x.ledger_account_id = ANY($10::uuid[])))
     ORDER BY t.txn_date, t.id, p.line_no`, [workspaceId, only.id ?? null, only.from ?? null, only.to ?? null, only.kind ?? null, only.origin ?? null, only.payeeId ?? null, only.status ?? null, only.excludeStatus ?? null, only.touching ?? null]);
  const byId = new Map<string, TransactionRecord>();
  for (const row of result.rows) {
    let record = byId.get(row.transaction_id);
    if (!record) {
      const tx: Transaction = { id: row.transaction_id, date: row.txn_date, kind: row.kind, status: row.status, postings: [] };
      if (row.refund_of_id) tx.refundOfId = row.refund_of_id;
      record = { tx, origin: row.origin, description: row.description, memo: row.memo, payeeId: row.payee_id, payeeName: row.payee_name, version: row.version, trashedAt: row.trashed_at };
      byId.set(row.transaction_id, record);
    }
    const amount = Number(row.amount_minor);
    if (!Number.isSafeInteger(amount)) throw new Error(`Unsafe amount in posting: ${row.amount_minor}`);
    record.tx.postings.push({
      ledgerAccountId: row.ledger_account_id,
      amount,
      ...(row.mark ? { mark: row.mark } : {}),
      ...(row.line_memo ? { memo: row.line_memo } : {}),
    });
  }
  return [...byId.values()];
}

/** Loads every transaction of the workspace with its postings, in line order. */
export async function loadTransactions(db: Db, workspaceId: string): Promise<Transaction[]> {
  return (await loadTransactionRecords(db, workspaceId)).map((record) => record.tx);
}

/**
 * What the Ledger needs, without loading every transaction (NFR-03): the postings summed per
 * day and account, directly from the index. Each row is a stand-in transaction holding one day's
 * totals, kept apart for opening balances because Cash Change leaves those out (§2.3). Only ever
 * posted money, so a Ledger built from this gives the same figures as one built from every
 * transaction: the golden tests run both. Not for anything that needs a transaction's identity.
 */
export async function loadLedgerTotals(db: Db, workspaceId: string, range: { from?: string; to?: string } = {}): Promise<Transaction[]> {
  const result = await db.query<{ txn_date: string; opening: boolean; ledger_account_id: string; amount: string }>(
    `SELECT to_char(p.txn_date, 'YYYY-MM-DD') AS txn_date, t.kind = 'opening_balance' AS opening, p.ledger_account_id, SUM(p.amount_minor)::text AS amount
       FROM fin.postings p JOIN fin.transactions t ON t.id = p.transaction_id AND t.workspace_id = p.workspace_id
      WHERE p.workspace_id = $1 AND p.txn_status = 'posted'
        AND ($2::date IS NULL OR p.txn_date >= $2) AND ($3::date IS NULL OR p.txn_date <= $3)
      GROUP BY 1, 2, 3`,
    [workspaceId, range.from ?? null, range.to ?? null],
  );
  const byDay = new Map<string, Transaction>();
  for (const row of result.rows) {
    const key = `${row.txn_date}|${row.opening}`;
    let tx = byDay.get(key);
    if (!tx) {
      tx = { id: key, date: row.txn_date, kind: row.opening ? 'opening_balance' : 'split', status: 'posted', postings: [] };
      byDay.set(key, tx);
    }
    const amount = Number(row.amount);
    if (!Number.isSafeInteger(amount)) throw new Error(`Unsafe total in postings: ${row.amount}`);
    tx.postings.push({ ledgerAccountId: row.ledger_account_id, amount });
  }
  return [...byDay.values()];
}

/** The newest posted and voided transactions, opening balances left out. */
export async function loadRecentRecords(db: Db, workspaceId: string, count: number): Promise<TransactionRecord[]> {
  const ids = await db.query<{ id: string }>(
    `SELECT id FROM fin.transactions WHERE workspace_id = $1 AND status <> 'trashed' AND kind <> 'opening_balance' ORDER BY txn_date DESC, id DESC LIMIT $2`,
    [workspaceId, count],
  );
  const records = [];
  for (const row of ids.rows) records.push((await loadTransactionRecords(db, workspaceId, row.id))[0]!);
  return records;
}

export async function loadTransactionRecord(db: Db, workspaceId: string, id: string): Promise<TransactionRecord | null> {
  return (await loadTransactionRecords(db, workspaceId, id))[0] ?? null;
}
