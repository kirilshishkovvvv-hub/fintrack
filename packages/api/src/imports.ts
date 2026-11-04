/**
 * CSV import as use cases (FR-16, Stage 1 §9.6): preview, create a batch in review, decide,
 * confirm all-or-nothing, undo. The file stays in the browser until a batch is created and is
 * dropped straight after parsing (BR-16.7). Matching planned occurrences joins with Stage 5.
 */
import { createHash } from 'node:crypto';
import {
  bodyRows,
  build,
  classifyRows,
  decodeBytes,
  detectFormat,
  IMPORT_MAX_ROWS,
  importedKey,
  isUserAccount,
  normalizeDescription,
  parseTable,
  readRows,
  todayIn,
  validateTransaction,
  type Chart,
  type ImportSettings,
  type Transaction,
} from '@fintrack/domain';
import {
  changeTransactionStatus,
  claimedTransactionIds,
  findCategoryBySystemKey,
  getBatch,
  getWorkspace,
  importedKeys,
  insertBatch,
  insertLedgerAccount,
  insertTransactionsBulk,
  listBatches,
  listProfiles,
  listRows,
  loadChart,
  loadTransactionRecords,
  lockedTransactionIds,
  recordAuditEvent,
  replaceTransaction,
  saveProfile,
  setBatchStatus,
  snapshotOf,
  updateRowDecisions,
  updateRowOutcomes,
  uuidv7,
  VersionConflict,
  type BatchRow,
  type Db,
  type ImportRow,
  type RequestContext,
  type TransactionRecord,
  type TransactionSnapshot,
} from '@fintrack/db';
import type { z } from 'zod';
import { ApiError } from './http.ts';
import type { importDecisionsBody, importSettings, previewSettings } from './schemas.ts';

const UNCATEGORIZED = { expense: { key: 'expense.uncategorized', name: 'Uncategorized' }, income: { key: 'income.uncategorized', name: 'Uncategorized income' } } as const;

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function readWith(bytes: Uint8Array, settings: ImportSettings) {
  const table = parseTable(decodeBytes(bytes, settings.encoding), settings.delimiter);
  return { table, rows: readRows(table, settings) };
}

function checkRowLimit(count: number) {
  if (count > IMPORT_MAX_ROWS) throw new ApiError(413, 'IMPORT_TOO_LARGE', `A file can hold at most ${IMPORT_MAX_ROWS} rows (BR-16.8)`);
}

/** Steps 2 and 3: what the file looks like, with any choices the user has changed. Nothing is stored. */
export function previewFile(bytes: Uint8Array, overrides: z.infer<typeof previewSettings>) {
  const detected = detectFormat(bytes, overrides.encoding);
  const settings = {
    encoding: detected.encoding,
    delimiter: overrides.delimiter ?? detected.delimiter,
    decimalSeparator: overrides.decimalSeparator ?? detected.decimalSeparator,
    dateFormat: overrides.dateFormat ?? detected.dateFormat ?? ('DD.MM.YYYY' as const),
    headerRow: overrides.headerRow === undefined ? detected.headerRow : overrides.headerRow,
    mapping: overrides.mapping ?? detected.mapping,
  };
  const table = parseTable(decodeBytes(bytes, settings.encoding), settings.delimiter);
  const ready = settings.mapping.date !== undefined && (settings.mapping.amount !== undefined || settings.mapping.debit !== undefined || settings.mapping.credit !== undefined);
  const rows = ready ? readRows(table, settings as ImportSettings) : [];
  checkRowLimit(rows.length);
  const width = Math.max(0, ...table.slice(0, 200).map((row) => row.length));
  return {
    settings,
    columns: Array.from({ length: width }, (_, index) => (settings.headerRow === null ? null : table[settings.headerRow]?.[index]?.trim()) || `Column ${index + 1}`),
    ready,
    rowCount: rows.length,
    unreadable: rows.filter((row) => row.problem).length,
    /** Lines that aren't data rows, such as a total at the bottom. Shown, so nothing vanishes unseen. */
    ignoredLines: table.length - (settings.headerRow === null ? 0 : settings.headerRow + 1) - bodyRows(table, settings.headerRow).length,
    sample: rows.slice(0, 8).map((row) => ({ rowNo: row.rowNo, date: row.date, amount_minor: row.amount, description: row.description, currency: row.currency, problem: row.problem })),
    hasCurrencyColumn: settings.mapping.currency !== undefined,
  };
}

/** The category of earlier transactions with the same text, as a suggestion (FR-16 step 8). */
function learnedCategories(records: readonly TransactionRecord[], chart: Chart): Map<string, string> {
  const learned = new Map<string, string>();
  for (const record of records) {
    if (record.tx.status !== 'posted' || !record.description) continue;
    const categories = record.tx.postings.filter((posting) => chart.find(posting.ledgerAccountId)?.category);
    if (categories.length === 1) learned.set(normalizeDescription(record.description), categories[0]!.ledgerAccountId);
  }
  return learned;
}

/** Steps 4 to 7: parses and classifies the rows into a batch in review. Nothing is posted (BR-16.1). */
export async function createBatch(
  db: Db,
  context: RequestContext,
  input: { bytes: Uint8Array; fileName: string | null; accountId: string; settings: z.infer<typeof importSettings>; saveProfileAs?: string | undefined },
) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  const account = chart.find(input.accountId);
  if (!account?.account) throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  if (account.archived) throw new ApiError(409, 'INVALID_STATE', 'Unarchive the account to import into it');
  const settings = input.settings as ImportSettings;
  const { rows } = readWith(input.bytes, settings);
  checkRowLimit(rows.length);
  if (rows.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'No rows could be read from this file with these settings');

  const records = await loadTransactionRecords(db, context.workspaceId);
  const locked = await lockedTransactionIds(db, context.workspaceId);
  const claimed = await claimedTransactionIds(db, context.workspaceId);
  const posted = records.filter((record) => record.tx.status === 'posted' && !claimed.has(record.tx.id));
  const sumOn = (tx: Transaction, accountId: string) => tx.postings.filter((p) => p.ledgerAccountId === accountId).reduce((sum, p) => sum + p.amount, 0);

  const others = chart.all().filter((other) => isUserAccount(other) && !other.archived && other.id !== input.accountId);
  const classified = classifyRows(rows, {
    today: todayIn(workspace.timezone),
    openingDate: account.account.openingDate,
    workspaceCurrency: workspace.currency,
    imported: await importedKeys(db, context.workspaceId, input.accountId),
    candidates: posted
      .filter((record) => record.tx.postings.some((p) => p.ledgerAccountId === input.accountId))
      .filter((record) => record.tx.kind === 'transfer' || (record.origin === 'manual' && !['opening_balance', 'adjustment', 'valuation'].includes(record.tx.kind)))
      .map((record) => ({ transactionId: record.tx.id, date: record.tx.date, amount: sumOn(record.tx, input.accountId), isTransfer: record.tx.kind === 'transfer' })),
    pairs: posted
      .filter((record) => (record.tx.kind === 'expense' || record.tx.kind === 'income') && record.tx.postings.length === 2 && !locked.has(record.tx.id))
      .flatMap((record) => {
        const side = record.tx.postings.find((p) => others.some((other) => other.id === p.ledgerAccountId));
        return side ? [{ transactionId: record.tx.id, accountId: side.ledgerAccountId, date: record.tx.date, amount: side.amount }] : [];
      }),
    otherAccounts: others.map((other) => ({ id: other.id, name: other.name })),
  });

  const learned = learnedCategories(records, chart);
  const batchId = uuidv7();
  const profileId = input.saveProfileAs ? await saveProfile(db, context.workspaceId, input.saveProfileAs, settings) : null;
  await insertBatch(
    db,
    context.workspaceId,
    {
      id: batchId,
      accountId: input.accountId,
      profileId,
      fileSha256: sha256(input.bytes),
      fileName: input.fileName?.slice(0, 255) ?? null,
      currencyAssumed: settings.mapping.currency === undefined,
      userId: context.userId,
    },
    classified.map((row) => {
      const suggestion = learned.get(normalizeDescription(row.description));
      return { ...row, categoryId: suggestion && !chart.find(suggestion)?.archived ? suggestion : null };
    }),
  );
  await event(db, context, 'import.created', batchId);
  return batchDto((await getBatch(db, context.workspaceId, batchId))!, await listRows(db, context.workspaceId, batchId), workspace.currency);
}

function event(db: Db, context: RequestContext, type: string, objectId: string, objectType = 'import') {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType, objectId });
}

function rowDto(row: ImportRow) {
  return {
    id: row.id,
    rowNo: row.rowNo,
    date: row.date,
    amount_minor: row.amount,
    description: row.description,
    counterparty: row.counterparty,
    reference: row.reference,
    currency: row.currency,
    classification: row.classification,
    rejectReason: row.rejectReason,
    decision: row.decision,
    categoryId: row.categoryId,
    counterAccountId: row.counterAccountId,
    candidateTransactionId: row.candidateTransactionId,
    claimedTransactionId: row.claimedTransactionId,
    createdTransactionId: row.createdTransactionId,
    state: row.state,
  };
}

function batchDto(batch: BatchRow, rows: readonly ImportRow[], currency: string) {
  const count = <K extends string>(values: K[]) => {
    const counts: Partial<Record<K, number>> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  };
  return {
    ...batch,
    currency,
    counts: count(rows.map((row) => row.classification)),
    states: count(rows.map((row) => row.state)),
    undecided: rows.filter((row) => row.state === 'pending' && !row.decision).length,
    rows: rows.map(rowDto),
  };
}

async function loadBatch(db: Db, context: RequestContext, id: string): Promise<BatchRow> {
  const batch = await getBatch(db, context.workspaceId, id);
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Import not found');
  return batch;
}

export async function listImports(db: Db, context: RequestContext) {
  const batches = await listBatches(db, context.workspaceId);
  const out = [];
  for (const batch of batches) {
    const { rows: _rows, ...summary } = batchDto(batch, await listRows(db, context.workspaceId, batch.id), (await getWorkspace(db, context.workspaceId)).currency);
    out.push(summary);
  }
  return out;
}

export async function getImport(db: Db, context: RequestContext, id: string) {
  const batch = await loadBatch(db, context, id);
  return batchDto(batch, await listRows(db, context.workspaceId, id), (await getWorkspace(db, context.workspaceId)).currency);
}

export const getProfiles = (db: Db, context: RequestContext) => listProfiles(db, context.workspaceId);

/** What each class of row may become. Rejected rows stay rejected: they can't be saved correctly. */
const ALLOWED: Record<ImportRow['classification'], readonly string[]> = {
  new: ['import', 'skip', 'transfer'],
  duplicate: ['skip', 'import'],
  possible_duplicate: ['link', 'import', 'skip'],
  already_recorded: ['link', 'import', 'skip'],
  transfer: ['transfer', 'import', 'skip'],
  rejected: [],
};

/** Step 9: the user's decisions on rows (BR-16.3, BR-16.4, BR-16.5). */
export async function decideRows(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof importDecisionsBody>) {
  const batch = await loadBatch(db, context, id);
  if (batch.version !== expectedVersion) throw new VersionConflict('This import was changed since you opened it');
  if (batch.status !== 'review') throw new ApiError(409, 'INVALID_STATE', 'This import is no longer in review');
  const rows = new Map((await listRows(db, context.workspaceId, id)).map((row) => [row.id, row]));
  const chart = await loadChart(db, context.workspaceId);
  const changes = input.decisions.map((change) => {
    const row = rows.get(change.rowId);
    if (!row) throw new ApiError(422, 'INVALID_REFERENCE', 'A row does not belong to this import');
    const decision = change.decision === undefined ? row.decision : change.decision;
    if (decision && !ALLOWED[row.classification].includes(decision)) {
      throw new ApiError(422, 'VALIDATION_FAILED', `A ${row.classification} row can't be set to ${decision}`);
    }
    const categoryId = change.categoryId === undefined ? row.categoryId : change.categoryId;
    if (categoryId) {
      const category = chart.find(categoryId);
      if (!category?.category || category.archived) throw new ApiError(422, 'INVALID_REFERENCE', 'The category does not exist');
    }
    const counterAccountId = change.counterAccountId === undefined ? row.counterAccountId : change.counterAccountId;
    if (counterAccountId) {
      const counter = chart.find(counterAccountId);
      if (!counter?.account || counter.archived || counterAccountId === row.accountId) throw new ApiError(422, 'INVALID_REFERENCE', 'Choose another of your accounts');
    }
    if (decision === 'transfer' && !counterAccountId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the other account of the transfer');
    // A pair is tied to its account: choosing a different account leaves the other entry alone.
    const pairStays = row.classification !== 'transfer' || counterAccountId === row.counterAccountId;
    return { id: row.id, decision, categoryId, counterAccountId, candidateTransactionId: pairStays ? row.candidateTransactionId : null };
  });
  await updateRowDecisions(db, context.workspaceId, changes);
  const version = await setBatchStatus(db, context.workspaceId, id, null, expectedVersion);
  if (version === null) throw new VersionConflict('This import was changed since you opened it');
  return getImport(db, context, id);
}

async function uncategorizedId(db: Db, context: RequestContext, kind: 'expense' | 'income'): Promise<string> {
  const { key, name } = UNCATEGORIZED[kind];
  const existing = await findCategoryBySystemKey(db, context.workspaceId, key);
  if (existing) return existing;
  const id = uuidv7();
  await insertLedgerAccount(db, context.workspaceId, { id, kind, name, category: {} }, { systemKey: key });
  return id;
}

/**
 * Step 10: creates everything in one database transaction (LR-03, GT-39 b). A retry with the same
 * key returns the stored answer, and the fingerprint index stops a double import regardless.
 */
export async function confirmImport(db: Db, context: RequestContext, id: string, input: { confirmCurrency?: boolean | undefined }) {
  const batch = await loadBatch(db, context, id);
  if (batch.status !== 'review') throw new ApiError(409, 'INVALID_STATE', 'This import is no longer in review');
  if (batch.currencyAssumed && !input.confirmCurrency) throw new ApiError(422, 'CURRENCY_CONFIRM_REQUIRED', 'Confirm that all amounts are in the workspace currency (BR-23.4)');
  const rows = await listRows(db, context.workspaceId, id);
  const undecided = rows.filter((row) => row.state === 'pending' && !row.decision);
  if (undecided.length > 0) throw new ApiError(422, 'DECISIONS_REQUIRED', 'Some rows need a decision', { rowNos: undecided.map((row) => row.rowNo) });

  const workspace = await getWorkspace(db, context.workspaceId);
  const today = todayIn(workspace.timezone);
  const pending = rows.filter((row) => row.state === 'pending');
  const needsCategory = (kind: 'expense' | 'income') => pending.some((row) => row.decision === 'import' && !row.categoryId && (kind === 'expense' ? row.amount! < 0 : row.amount! > 0));
  const fallback = {
    expense: needsCategory('expense') ? await uncategorizedId(db, context, 'expense') : null,
    income: needsCategory('income') ? await uncategorizedId(db, context, 'income') : null,
  };
  const chart = await loadChart(db, context.workspaceId);
  const taken = await importedKeys(db, context.workspaceId, batch.accountId);
  const records = new Map((await loadTransactionRecords(db, context.workspaceId)).map((record) => [record.tx.id, record]));

  const created: { tx: Transaction; description: string | null }[] = [];
  const outcomes = [];
  for (const row of rows) {
    if (row.state !== 'pending') continue;
    const base = { id: row.id, ordinal: row.ordinal, claimedTransactionId: null as string | null, createdTransactionId: null as string | null, replacedSnapshot: null as unknown };
    let ordinal = row.ordinal;
    if (row.decision === 'skip') {
      outcomes.push({ ...base, state: 'skipped' as const });
      continue;
    }
    if (row.fingerprint && taken.has(importedKey(row.fingerprint, ordinal))) {
      // Imported by another batch since the review was opened: only an explicit override adds it again.
      if (row.classification !== 'duplicate') {
        outcomes.push({ ...base, state: 'skipped' as const });
        continue;
      }
      while (taken.has(importedKey(row.fingerprint, ordinal))) ordinal += 1;
    }
    if (row.fingerprint) taken.add(importedKey(row.fingerprint, ordinal));
    const amount = row.amount!;
    const date = row.date!;
    const description = row.description;
    if (row.decision === 'link') {
      outcomes.push({ ...base, state: 'imported' as const, claimedTransactionId: row.candidateTransactionId });
      continue;
    }
    const txId = uuidv7();
    if (row.decision === 'transfer') {
      const size = Math.abs(amount);
      const ends = amount < 0 ? { fromId: row.accountId, toId: row.counterAccountId! } : { fromId: row.counterAccountId!, toId: row.accountId };
      const existing = row.candidateTransactionId ? records.get(row.candidateTransactionId) : undefined;
      if (existing && existing.tx.status === 'posted') {
        // BR-16.5: the other side is already there as income or an expense, so that entry becomes the one transfer.
        const tx = build.transfer({ id: existing.tx.id, date, ...ends, amount: size });
        validateTransaction(tx, chart, { today });
        await replaceTransaction(db, context.workspaceId, tx, { description: existing.description, memo: existing.memo, expectedVersion: existing.version, userId: context.userId });
        outcomes.push({ ...base, ordinal, state: 'imported' as const, claimedTransactionId: existing.tx.id, replacedSnapshot: snapshotOf(existing.tx, existing) });
        continue;
      }
      const tx = build.transfer({ id: txId, date, ...ends, amount: size });
      validateTransaction(tx, chart, { today });
      created.push({ tx, description });
      outcomes.push({ ...base, ordinal, state: 'imported' as const, createdTransactionId: txId });
      continue;
    }
    if (row.classification === 'possible_duplicate') await event(db, context, 'import.kept_both', row.id, 'import_row');
    const categoryId = row.categoryId ?? (amount < 0 ? fallback.expense! : fallback.income!);
    const kind = chart.get(categoryId).kind;
    const lines = [{ categoryId, amount: Math.abs(amount) }];
    const base2 = { id: txId, date, accountId: row.accountId, lines };
    // A row against the grain of its category reverses that category (E-31, E-35).
    const tx = amount < 0 && kind === 'expense' ? build.expense(base2) : amount > 0 && kind === 'income' ? build.income(base2) : build.refund(chart, base2);
    validateTransaction(tx, chart, { today });
    created.push({ tx, description });
    outcomes.push({ ...base, ordinal, state: 'imported' as const, createdTransactionId: txId });
  }

  await insertTransactionsBulk(db, context.workspaceId, created, { origin: 'import', userId: context.userId });
  await updateRowOutcomes(db, context.workspaceId, outcomes);
  if ((await setBatchStatus(db, context.workspaceId, id, 'confirmed', batch.version)) === null) throw new VersionConflict('This import was changed since you opened it');
  await event(db, context, 'import.confirmed', id);
  return getImport(db, context, id);
}

/**
 * Undo (BR-16.6, E-57): voids what the batch created, unlinks what it claimed, and returns any
 * entry it turned into a transfer to what it was. Blocked while something is reconciled;
 * transactions edited since the import are listed for confirmation.
 */
export async function undoImport(db: Db, context: RequestContext, id: string, input: { confirmEdited?: boolean | undefined }) {
  const batch = await loadBatch(db, context, id);
  if (batch.status !== 'confirmed') throw new ApiError(409, 'INVALID_STATE', 'Only a confirmed import can be undone');
  const rows = (await listRows(db, context.workspaceId, id)).filter((row) => row.state === 'imported');
  const records = new Map((await loadTransactionRecords(db, context.workspaceId)).map((record) => [record.tx.id, record]));
  const locked = await lockedTransactionIds(db, context.workspaceId);
  const changed = rows.flatMap((row) => [row.createdTransactionId, row.replacedSnapshot ? row.claimedTransactionId : null]).filter((txId): txId is string => txId !== null);
  const blocked = changed.filter((txId) => locked.has(txId));
  if (blocked.length > 0) throw new ApiError(409, 'LOCKED_RECONCILED', 'Unlock the reconciliation of these transactions first', { transactionIds: blocked });
  const edited = rows.flatMap((row) => (row.createdTransactionId && (records.get(row.createdTransactionId)?.version ?? 1) > 1 ? [row.createdTransactionId] : []));
  if (edited.length > 0 && !input.confirmEdited) throw new ApiError(409, 'IMPORT_EDITED', 'Some transactions were edited after the import', { transactionIds: edited });

  for (const row of rows) {
    const created = row.createdTransactionId ? records.get(row.createdTransactionId) : undefined;
    if (created?.tx.status === 'posted') {
      await changeTransactionStatus(db, context.workspaceId, created.tx.id, { to: 'voided', type: 'void', expectedVersion: created.version, userId: context.userId });
    }
    const replaced = row.replacedSnapshot as TransactionSnapshot | null;
    const current = row.claimedTransactionId ? records.get(row.claimedTransactionId) : undefined;
    if (replaced && current) {
      const tx: Transaction = { id: current.tx.id, date: replaced.date, kind: replaced.kind, status: 'posted', postings: replaced.postings };
      if (replaced.refundOfId) tx.refundOfId = replaced.refundOfId;
      await replaceTransaction(db, context.workspaceId, tx, { description: replaced.description, memo: replaced.memo, expectedVersion: current.version, userId: context.userId });
    }
  }
  await updateRowOutcomes(
    db,
    context.workspaceId,
    rows.map((row) => ({ id: row.id, state: 'undone' as const, ordinal: row.ordinal, claimedTransactionId: row.claimedTransactionId, createdTransactionId: row.createdTransactionId, replacedSnapshot: row.replacedSnapshot })),
  );
  if ((await setBatchStatus(db, context.workspaceId, id, 'undone', batch.version)) === null) throw new VersionConflict('This import was changed since you opened it');
  await event(db, context, 'import.undone', id);
  return getImport(db, context, id);
}

export async function discardImport(db: Db, context: RequestContext, id: string) {
  const batch = await loadBatch(db, context, id);
  if (batch.status !== 'review') throw new ApiError(409, 'INVALID_STATE', 'Only an import in review can be discarded');
  if ((await setBatchStatus(db, context.workspaceId, id, 'discarded', batch.version)) === null) throw new VersionConflict('This import was changed since you opened it');
  await event(db, context, 'import.discarded', id);
  return { id, status: 'discarded' };
}
