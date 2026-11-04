/** Import batches, their parsed rows and saved column mappings (FR-16, BR-16.7). The file is never stored. */
import { importedKey, type ClassifiedRow, type ImportSettings, type RejectReason, type RowClass, type RowDecision } from '@fintrack/domain';
import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';

export type BatchStatus = 'review' | 'confirmed' | 'undone' | 'discarded';
export type RowState = 'pending' | 'imported' | 'skipped' | 'rejected' | 'undone';

export interface BatchRow {
  id: string;
  accountId: string;
  status: BatchStatus;
  fileName: string | null;
  rowCount: number;
  currencyAssumed: boolean;
  version: number;
  createdAt: string;
  confirmedAt: string | null;
  undoneAt: string | null;
}

export interface ImportRow {
  id: string;
  rowNo: number;
  accountId: string;
  date: string | null;
  amount: number | null;
  description: string | null;
  counterparty: string | null;
  reference: string | null;
  currency: string | null;
  fingerprint: string | null;
  ordinal: number;
  classification: RowClass;
  rejectReason: RejectReason | null;
  decision: RowDecision | null;
  categoryId: string | null;
  counterAccountId: string | null;
  candidateTransactionId: string | null;
  claimedTransactionId: string | null;
  createdTransactionId: string | null;
  replacedSnapshot: unknown;
  state: RowState;
}

export interface ProfileRow extends ImportSettings {
  id: string;
  name: string;
}

export async function saveProfile(db: Db, workspaceId: string, name: string, settings: ImportSettings): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO fin.import_profiles (id, workspace_id, name, encoding, delimiter, decimal_separator, date_format, header_row, mapping)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workspace_id, name) DO UPDATE
       SET encoding = EXCLUDED.encoding, delimiter = EXCLUDED.delimiter, decimal_separator = EXCLUDED.decimal_separator,
           date_format = EXCLUDED.date_format, header_row = EXCLUDED.header_row, mapping = EXCLUDED.mapping, updated_at = now()
     RETURNING id`,
    [uuidv7(), workspaceId, name, settings.encoding, settings.delimiter, settings.decimalSeparator, settings.dateFormat, settings.headerRow, JSON.stringify(settings.mapping)],
  );
  return result.rows[0]!.id;
}

export async function listProfiles(db: Db, workspaceId: string): Promise<ProfileRow[]> {
  const result = await db.query<{
    id: string;
    name: string;
    encoding: ImportSettings['encoding'];
    delimiter: string;
    decimal_separator: ImportSettings['decimalSeparator'];
    date_format: ImportSettings['dateFormat'];
    header_row: number | null;
    mapping: ImportSettings['mapping'];
  }>('SELECT id, name, encoding, delimiter, decimal_separator, date_format, header_row, mapping FROM fin.import_profiles WHERE workspace_id = $1 ORDER BY name', [workspaceId]);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    encoding: row.encoding,
    delimiter: row.delimiter,
    decimalSeparator: row.decimal_separator,
    dateFormat: row.date_format,
    headerRow: row.header_row,
    mapping: row.mapping,
  }));
}

/** Stores the batch and its rows in one statement each, so a 10,000-row file stays fast (NFR-03). */
export async function insertBatch(
  db: Db,
  workspaceId: string,
  batch: { id: string; accountId: string; profileId: string | null; fileSha256: string; fileName: string | null; currencyAssumed: boolean; userId: string },
  rows: readonly (ClassifiedRow & { categoryId: string | null })[],
): Promise<void> {
  await db.query(
    `INSERT INTO fin.import_batches (id, workspace_id, account_id, profile_id, file_sha256, file_name, row_count, currency_assumed, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [batch.id, workspaceId, batch.accountId, batch.profileId, batch.fileSha256, batch.fileName, rows.length, batch.currencyAssumed, batch.userId],
  );
  const records = rows.map((row) => ({
    id: uuidv7(),
    row_no: row.rowNo,
    row_date: row.date,
    amount_minor: row.amount,
    description: row.description || null,
    counterparty: row.counterparty,
    reference: row.reference,
    currency_code: row.currency,
    fingerprint: row.fingerprint,
    ordinal: row.ordinal,
    classification: row.classification,
    reject_reason: row.rejectReason,
    decision: row.decision,
    category_id: row.categoryId,
    counter_account_id: row.counterAccountId,
    candidate_transaction_id: row.candidateTransactionId,
    state: row.classification === 'rejected' ? 'rejected' : 'pending',
  }));
  await db.query(
    `INSERT INTO fin.import_rows (id, workspace_id, batch_id, account_id, row_no, row_date, amount_minor, description, counterparty, reference,
                                  currency_code, fingerprint, ordinal, classification, reject_reason, decision, category_id, counter_account_id,
                                  candidate_transaction_id, state)
     SELECT x.id, $1, $2, $3, x.row_no, x.row_date, x.amount_minor, x.description, x.counterparty, x.reference,
            x.currency_code, x.fingerprint, x.ordinal, x.classification, x.reject_reason, x.decision, x.category_id, x.counter_account_id,
            x.candidate_transaction_id, x.state
       FROM jsonb_to_recordset($4::jsonb) AS x(
         id uuid, row_no int, row_date date, amount_minor bigint, description text, counterparty text, reference text,
         currency_code text, fingerprint text, ordinal int, classification text, reject_reason text, decision text,
         category_id uuid, counter_account_id uuid, candidate_transaction_id uuid, state text)`,
    [workspaceId, batch.id, batch.accountId, JSON.stringify(records)],
  );
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

interface RawBatch {
  id: string;
  account_id: string;
  status: BatchStatus;
  file_name: string | null;
  row_count: number;
  currency_assumed: boolean;
  version: number;
  created_at: Date;
  confirmed_at: Date | null;
  undone_at: Date | null;
}

const toBatch = (row: RawBatch): BatchRow => ({
  id: row.id,
  accountId: row.account_id,
  status: row.status,
  fileName: row.file_name,
  rowCount: row.row_count,
  currencyAssumed: row.currency_assumed,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  confirmedAt: iso(row.confirmed_at),
  undoneAt: iso(row.undone_at),
});

const BATCH_COLUMNS = 'id, account_id, status, file_name, row_count, currency_assumed, version, created_at, confirmed_at, undone_at';

export async function getBatch(db: Db, workspaceId: string, id: string): Promise<BatchRow | null> {
  const result = await db.query<RawBatch>(`SELECT ${BATCH_COLUMNS} FROM fin.import_batches WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
  return result.rows[0] ? toBatch(result.rows[0]) : null;
}

export async function listBatches(db: Db, workspaceId: string): Promise<BatchRow[]> {
  const result = await db.query<RawBatch>(
    `SELECT ${BATCH_COLUMNS} FROM fin.import_batches WHERE workspace_id = $1 AND status <> 'discarded' ORDER BY created_at DESC LIMIT 100`,
    [workspaceId],
  );
  return result.rows.map(toBatch);
}

export async function listRows(db: Db, workspaceId: string, batchId: string): Promise<ImportRow[]> {
  const result = await db.query<{
    id: string;
    row_no: number;
    account_id: string;
    row_date: string | null;
    amount_minor: string | null;
    description: string | null;
    counterparty: string | null;
    reference: string | null;
    currency_code: string | null;
    fingerprint: string | null;
    ordinal: number;
    classification: RowClass;
    reject_reason: RejectReason | null;
    decision: RowDecision | null;
    category_id: string | null;
    counter_account_id: string | null;
    candidate_transaction_id: string | null;
    claimed_transaction_id: string | null;
    created_transaction_id: string | null;
    replaced_snapshot: unknown;
    state: RowState;
  }>(
    `SELECT id, row_no, account_id, to_char(row_date, 'YYYY-MM-DD') AS row_date, amount_minor::text, description, counterparty, reference, currency_code,
            fingerprint, ordinal, classification, reject_reason, decision, category_id, counter_account_id, candidate_transaction_id,
            claimed_transaction_id, created_transaction_id, replaced_snapshot, state
       FROM fin.import_rows WHERE workspace_id = $1 AND batch_id = $2 ORDER BY row_no`,
    [workspaceId, batchId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    rowNo: row.row_no,
    accountId: row.account_id,
    date: row.row_date,
    amount: row.amount_minor === null ? null : Number(row.amount_minor),
    description: row.description,
    counterparty: row.counterparty,
    reference: row.reference,
    currency: row.currency_code,
    fingerprint: row.fingerprint,
    ordinal: row.ordinal,
    classification: row.classification,
    rejectReason: row.reject_reason,
    decision: row.decision,
    categoryId: row.category_id,
    counterAccountId: row.counter_account_id,
    candidateTransactionId: row.candidate_transaction_id,
    claimedTransactionId: row.claimed_transaction_id,
    createdTransactionId: row.created_transaction_id,
    replacedSnapshot: row.replaced_snapshot,
    state: row.state,
  }));
}

/** Everything already imported into the account, for telling exact duplicates apart (BR-16.3). */
export async function importedKeys(db: Db, workspaceId: string, accountId: string): Promise<Set<string>> {
  const result = await db.query<{ fingerprint: string; ordinal: number }>(
    `SELECT fingerprint, ordinal FROM fin.import_rows WHERE workspace_id = $1 AND account_id = $2 AND state = 'imported'`,
    [workspaceId, accountId],
  );
  return new Set(result.rows.map((row) => importedKey(row.fingerprint, row.ordinal)));
}

/** Transactions an import row already claims: each can be claimed once (BR-16.9). */
export async function claimedTransactionIds(db: Db, workspaceId: string): Promise<Set<string>> {
  const result = await db.query<{ claimed_transaction_id: string }>(
    `SELECT claimed_transaction_id FROM fin.import_rows WHERE workspace_id = $1 AND state = 'imported' AND claimed_transaction_id IS NOT NULL`,
    [workspaceId],
  );
  return new Set(result.rows.map((row) => row.claimed_transaction_id));
}

export async function updateRowDecisions(
  db: Db,
  workspaceId: string,
  changes: readonly { id: string; decision: RowDecision | null; categoryId: string | null; counterAccountId: string | null; candidateTransactionId: string | null }[],
): Promise<void> {
  await db.query(
    `UPDATE fin.import_rows r
        SET decision = x.decision, category_id = x.category_id, counter_account_id = x.counter_account_id, candidate_transaction_id = x.candidate_transaction_id
       FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, decision text, category_id uuid, counter_account_id uuid, candidate_transaction_id uuid)
      WHERE r.workspace_id = $1 AND r.id = x.id`,
    [
      workspaceId,
      JSON.stringify(changes.map((c) => ({ id: c.id, decision: c.decision, category_id: c.categoryId, counter_account_id: c.counterAccountId, candidate_transaction_id: c.candidateTransactionId }))),
    ],
  );
}

export async function updateRowOutcomes(
  db: Db,
  workspaceId: string,
  outcomes: readonly { id: string; state: RowState; ordinal: number; claimedTransactionId: string | null; createdTransactionId: string | null; replacedSnapshot: unknown }[],
): Promise<void> {
  await db.query(
    `UPDATE fin.import_rows r
        SET state = x.state, ordinal = x.ordinal, claimed_transaction_id = x.claimed_transaction_id,
            created_transaction_id = x.created_transaction_id, replaced_snapshot = x.replaced_snapshot
       FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, state text, ordinal int, claimed_transaction_id uuid, created_transaction_id uuid, replaced_snapshot jsonb)
      WHERE r.workspace_id = $1 AND r.id = x.id`,
    [
      workspaceId,
      JSON.stringify(
        outcomes.map((o) => ({ id: o.id, state: o.state, ordinal: o.ordinal, claimed_transaction_id: o.claimedTransactionId, created_transaction_id: o.createdTransactionId, replaced_snapshot: o.replacedSnapshot })),
      ),
    ],
  );
}

/** Moves a batch on, checking the version so that two changes can't both win (AD-07). Returns the new version, or null. */
export async function setBatchStatus(db: Db, workspaceId: string, id: string, status: BatchStatus | null, expectedVersion: number): Promise<number | null> {
  const result = await db.query<{ version: number }>(
    `UPDATE fin.import_batches
        SET status = COALESCE($3, status),
            confirmed_at = CASE WHEN $3 = 'confirmed' THEN now() ELSE confirmed_at END,
            undone_at = CASE WHEN $3 = 'undone' THEN now() ELSE undone_at END,
            version = version + 1
      WHERE workspace_id = $1 AND id = $2 AND version = $4
      RETURNING version`,
    [workspaceId, id, status, expectedVersion],
  );
  return result.rows[0]?.version ?? null;
}

/** The workspace's system "Uncategorized" category of a kind (FR-05), created the first time it's needed. */
export async function findCategoryBySystemKey(db: Db, workspaceId: string, systemKey: string): Promise<string | null> {
  const result = await db.query<{ ledger_account_id: string }>('SELECT ledger_account_id FROM fin.categories WHERE workspace_id = $1 AND system_key = $2', [workspaceId, systemKey]);
  return result.rows[0]?.ledger_account_id ?? null;
}
