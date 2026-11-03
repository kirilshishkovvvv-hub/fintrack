/**
 * Application services (Stage 2 §4.1): use-case orchestration inside one database
 * transaction. Financial rules come from the domain module; nothing is calculated here.
 */
import {
  build,
  Ledger,
  safeToSpend,
  todayIn,
  validateTransaction,
  type AccountClass,
  type AccountType,
  type Chart,
  type LedgerAccount,
  type Transaction,
} from '@fintrack/domain';
import {
  changeTransactionStatus,
  createWorkspace,
  findUndoableVersion,
  getWorkspace,
  insertLedgerAccount,
  insertTransaction,
  listTransactionVersions,
  loadChart,
  loadTransactionRecord,
  loadTransactionRecords,
  loadTransactions,
  recordAuditEvent,
  replaceTransaction,
  uuidv7,
  VersionConflict,
  workspaceIdsForUser,
  type Db,
  type RequestContext,
  type TransactionRecord,
  type TransactionSnapshot,
  type TransactionText,
  type WorkspaceRow,
} from '@fintrack/db';
import type { z } from 'zod';
import { ApiError } from './http.ts';
import type {
  createAccountBody,
  createCategoryBody,
  createTransactionBody,
  createTransferBody,
  createWorkspaceBody,
  editTransactionBody,
} from './schemas.ts';
import { DEFAULT_CATEGORIES } from './seed.ts';

const CLASS_BY_TYPE: Record<AccountType, AccountClass> = {
  current: 'cash',
  savings: 'cash',
  cash: 'cash',
  investment: 'investment',
  lent: 'other_asset',
  other_asset: 'other_asset',
  card: 'liability',
  loan: 'liability',
  other_liability: 'liability',
};

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * Creates the user's personal workspace with its system accounts and default categories
 * (BR-02.1, BR-05.2). A user has one workspace (A-5): a repeat returns the existing one.
 */
export async function createOrGetWorkspace(
  db: Db,
  context: RequestContext,
  input: z.infer<typeof createWorkspaceBody>,
): Promise<{ workspaceId: string; created: boolean }> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('user:' || $1, 0))", [context.userId]);
  const existing = (await workspaceIdsForUser(db, context.userId)).filter((id) => id !== context.workspaceId);
  if (existing[0]) return { workspaceId: existing[0], created: false };

  await createWorkspace(db, {
    id: context.workspaceId,
    name: input.name,
    currency: input.currency,
    timezone: input.timezone,
    ownerUserId: context.userId,
  });
  for (const seed of DEFAULT_CATEGORIES) {
    const parentId = uuidv7();
    await insertLedgerAccount(db, context.workspaceId, { id: parentId, kind: seed.kind, name: seed.name, category: {} }, { systemKey: seed.systemKey });
    for (const child of seed.children ?? []) {
      await insertLedgerAccount(
        db,
        context.workspaceId,
        { id: uuidv7(), kind: seed.kind, name: child.name, category: { parentId } },
        { systemKey: child.systemKey },
      );
    }
  }
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'workspace.created', objectType: 'workspace', objectId: context.workspaceId });
  return { workspaceId: context.workspaceId, created: true };
}

export function workspaceDto(workspace: WorkspaceRow) {
  return {
    id: workspace.id,
    name: workspace.name,
    currency: workspace.currency,
    timezone: workspace.timezone,
    protectedReserve_minor: workspace.protectedReserveMinor,
  };
}

// ---------------------------------------------------------------------------
// Accounts and categories
// ---------------------------------------------------------------------------

export async function createAccount(db: Db, context: RequestContext, input: z.infer<typeof createAccountBody>) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const accountClass = CLASS_BY_TYPE[input.type];
  const account: LedgerAccount = {
    id: uuidv7(),
    kind: accountClass === 'liability' ? 'liability' : 'asset',
    name: input.name,
    account: {
      class: accountClass,
      type: input.type,
      spendable: input.spendable ?? (accountClass === 'cash' && input.type !== 'savings'),
      cardReserve: input.cardReserve ?? input.type === 'card',
      openingDate: input.openingDate,
    },
  };
  if (account.account!.spendable && accountClass !== 'cash') {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Only cash accounts can be spendable (LR-18)');
  }
  if (account.account!.cardReserve && input.type !== 'card') {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Only credit cards have a card reserve (LR-18)');
  }
  await insertLedgerAccount(db, context.workspaceId, account);

  const chart = await loadChart(db, context.workspaceId);
  const opening = build.openingBalance(chart, {
    id: uuidv7(),
    date: input.openingDate,
    accountId: account.id,
    amount: input.openingAmount_minor,
  });
  if (opening) {
    validateTransaction(opening, chart, { today: todayIn(workspace.timezone) });
    await insertTransaction(db, context.workspaceId, opening, { origin: 'system', userId: context.userId });
  }
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'account.created', objectType: 'account', objectId: account.id });
  return accountDto(new Ledger(chart, await loadTransactions(db, context.workspaceId)), chart.get(account.id), todayIn(workspace.timezone));
}

export async function listAccounts(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  const ledger = new Ledger(chart, await loadTransactions(db, context.workspaceId));
  const today = todayIn(workspace.timezone);
  return chart
    .all()
    .filter((account) => account.account)
    .map((account) => accountDto(ledger, account, today));
}

function accountDto(ledger: Ledger, account: LedgerAccount, today: string) {
  const info = account.account!;
  return {
    id: account.id,
    name: account.name,
    type: info.type,
    class: info.class,
    spendable: info.spendable,
    cardReserve: info.cardReserve,
    openingDate: info.openingDate,
    archived: account.archived ?? false,
    balance_minor: ledger.balance(account.id, today),
  };
}

export async function createCategory(db: Db, context: RequestContext, input: z.infer<typeof createCategoryBody>) {
  const chart = await loadChart(db, context.workspaceId);
  if (input.parentId) {
    const parent = chart.find(input.parentId);
    if (!parent?.category) throw new ApiError(422, 'INVALID_REFERENCE', 'The parent category does not exist');
    if (parent.kind !== input.kind) throw new ApiError(422, 'VALIDATION_FAILED', 'A subcategory must have the same kind as its parent');
  }
  const category: LedgerAccount = { id: uuidv7(), kind: input.kind, name: input.name, category: input.parentId ? { parentId: input.parentId } : {} };
  await insertLedgerAccount(db, context.workspaceId, category);
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'category.created', objectType: 'category', objectId: category.id });
  return categoryDto(category);
}

export async function listCategories(db: Db, context: RequestContext) {
  return (await loadChart(db, context.workspaceId))
    .all()
    .filter((account) => account.category)
    .map(categoryDto);
}

function categoryDto(account: LedgerAccount) {
  return { id: account.id, name: account.name, kind: account.kind, parentId: account.category?.parentId ?? null, archived: account.archived ?? false };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

type TransactionInput = z.infer<typeof createTransactionBody>;
type TransferInput = z.infer<typeof createTransferBody>;
type EditInput = z.infer<typeof editTransactionBody>;

/** The undo toast stays for 10 seconds (GAP-4); the server allows a few more for the network. */
export const UNDO_SECONDS = 10;
const UNDO_GRACE_SECONDS = 5;

/** Opening balances, adjustments and valuations change through their own flows, not an edit. */
const SYSTEM_KINDS: ReadonlySet<Transaction['kind']> = new Set(['opening_balance', 'adjustment', 'valuation']);

function buildFromIntention(chart: Chart, id: string, input: EditInput): Transaction {
  switch (input.kind) {
    case 'transfer':
      return buildTransfer(id, input);
    case 'expense':
    case 'income': {
      const lines = input.lines.map((line) => ({
        categoryId: line.categoryId,
        amount: line.amount_minor,
        ...(line.mark ? { mark: line.mark } : {}),
      }));
      return input.kind === 'expense'
        ? build.expense({ id, date: input.date, accountId: input.accountId, lines })
        : build.income({ id, date: input.date, accountId: input.accountId, lines });
    }
    case 'refund':
      return build.refund(chart, {
        id,
        date: input.date,
        accountId: input.accountId,
        lines: input.lines.map((line) => ({ categoryId: line.categoryId, amount: line.amount_minor })),
        ...(input.refundOfId ? { refundOfId: input.refundOfId } : {}),
      });
    case 'debt_payment':
      return build.debtPayment({
        id,
        date: input.date,
        fromId: input.fromAccountId,
        liabilityId: input.liabilityAccountId,
        principal: input.principal_minor,
        extras: (input.extras ?? []).map((line) => ({ categoryId: line.categoryId, amount: line.amount_minor })),
      });
    case 'split':
      return build.split({
        id,
        date: input.date,
        lines: input.lines.map((line) => ({ ledgerAccountId: line.ledgerAccountId, amount: line.amount_minor })),
      });
  }
}

function buildTransfer(id: string, input: TransferInput): Transaction {
  const base = { id, date: input.date, fromId: input.fromAccountId, toId: input.toAccountId, amount: input.amount_minor };
  return input.fee ? build.transfer({ ...base, fee: { categoryId: input.fee.categoryId, amount: input.fee.amount_minor } }) : build.transfer(base);
}

type TextInput = { description?: string | undefined; memo?: string | undefined };
const textOf = (input: TextInput): TransactionText => ({ description: input.description ?? null, memo: input.memo ?? null });

/** Validates a new or changed transaction exactly as the domain module defines it (§5, LR-01..18). */
async function checkAgainstLedger(db: Db, context: RequestContext, tx: Transaction, chart: Chart) {
  const workspace = await getWorkspace(db, context.workspaceId);
  if (tx.refundOfId) {
    const original = tx.refundOfId === tx.id ? null : await loadTransactionRecord(db, context.workspaceId, tx.refundOfId);
    if (!original) throw new ApiError(422, 'INVALID_REFERENCE', 'The original transaction does not exist');
  }
  validateTransaction(tx, chart, { today: todayIn(workspace.timezone) });
}

function audit(db: Db, context: RequestContext, type: string, transactionId: string) {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType: 'transaction', objectId: transactionId });
}

async function record(db: Db, context: RequestContext, tx: Transaction, chart: Chart, input: TextInput) {
  await checkAgainstLedger(db, context, tx, chart);
  const text = textOf(input);
  const { versionId } = await insertTransaction(db, context.workspaceId, tx, {
    origin: 'manual',
    userId: context.userId,
    ...(text.description ? { description: text.description } : {}),
    ...(text.memo ? { memo: text.memo } : {}),
  });
  await audit(db, context, 'transaction.created', tx.id);
  return withUndo(transactionDto({ tx, origin: 'manual', version: 1, trashedAt: null, ...text }), versionId);
}

export async function recordTransaction(db: Db, context: RequestContext, input: TransactionInput) {
  const chart = await loadChart(db, context.workspaceId);
  return record(db, context, buildFromIntention(chart, uuidv7(), input), chart, input);
}

export async function recordTransfer(db: Db, context: RequestContext, input: TransferInput) {
  const chart = await loadChart(db, context.workspaceId);
  return record(db, context, buildTransfer(uuidv7(), input), chart, input);
}

/** The activity list: posted and voided transactions (voided ones stay visible, FR-19), newest first. */
export async function listTransactions(db: Db, context: RequestContext, period: { from: string; to: string }) {
  return (await loadTransactionRecords(db, context.workspaceId))
    .filter((record) => record.tx.status !== 'trashed' && record.tx.date >= period.from && record.tx.date <= period.to)
    .sort((a, b) => (a.tx.date === b.tx.date ? (a.tx.id < b.tx.id ? 1 : -1) : a.tx.date < b.tx.date ? 1 : -1))
    .map(transactionDto);
}

/** The trash: recoverable for 30 days, then purged (FR-19, OD-05). Most recently deleted first. */
export async function listTrash(db: Db, context: RequestContext) {
  return (await loadTransactionRecords(db, context.workspaceId))
    .filter((record) => record.tx.status === 'trashed')
    .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1))
    .map((record) => ({ ...transactionDto(record), purgeAfter: addDaysToTimestamp(record.trashedAt!, TRASH_DAYS) }));
}

async function loadOrNotFound(db: Db, context: RequestContext, id: string): Promise<TransactionRecord> {
  const record = await loadTransactionRecord(db, context.workspaceId, id);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  return record;
}

/** Detail with lines and the full version history (Stage 2 §9.2, FR-19). */
export async function getTransaction(db: Db, context: RequestContext, id: string) {
  const record = await loadOrNotFound(db, context, id);
  const versions = await listTransactionVersions(db, context.workspaceId, id);
  return {
    ...transactionDto(record),
    versions: versions.map((entry) => ({
      version: entry.version,
      changeType: entry.changeType,
      changedAt: entry.changedAt,
      before: snapshotDto(entry.before),
      after: snapshotDto(entry.after),
    })),
  };
}

/** Replaces a posted transaction with a new intention (E-38, LR-10). */
export async function editTransaction(db: Db, context: RequestContext, id: string, expectedVersion: number, input: EditInput) {
  const existing = await loadOrNotFound(db, context, id);
  if (existing.version !== expectedVersion) throw new VersionConflict('The transaction was changed since you opened it');
  if (existing.tx.status !== 'posted') throw new ApiError(409, 'INVALID_STATE', 'Restore the transaction before editing it');
  if (SYSTEM_KINDS.has(existing.tx.kind)) {
    throw new ApiError(422, 'NOT_EDITABLE', 'Opening balances and adjustments are changed from the account, not edited here');
  }
  const chart = await loadChart(db, context.workspaceId);
  const tx = buildFromIntention(chart, id, input);
  await checkAgainstLedger(db, context, tx, chart);
  const text = textOf(input);
  const result = await replaceTransaction(db, context.workspaceId, tx, { ...text, expectedVersion, userId: context.userId });
  await audit(db, context, 'transaction.edited', id);
  return withUndo(transactionDto({ ...existing, ...text, tx, version: result.version }), result.versionId);
}

const TRANSITIONS = {
  void: { from: ['posted'], to: 'voided', event: 'transaction.voided' },
  trash: { from: ['posted'], to: 'trashed', event: 'transaction.trashed' },
  restore: { from: ['voided', 'trashed'], to: 'posted', event: 'transaction.restored' },
} as const satisfies Record<string, { from: readonly Transaction['status'][]; to: Transaction['status']; event: string }>;

const TRASH_DAYS = 30;

/** Void, trash or restore (§9.3). Restoring re-checks the ledger rules, e.g. an archived account (LR-14). */
export async function changeStatus(
  db: Db,
  context: RequestContext,
  id: string,
  action: keyof typeof TRANSITIONS,
  expectedVersion?: number,
) {
  const existing = await loadOrNotFound(db, context, id);
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    throw new VersionConflict('The transaction was changed since you opened it');
  }
  const transition = TRANSITIONS[action];
  if (!(transition.from as readonly string[]).includes(existing.tx.status)) {
    throw new ApiError(409, 'INVALID_STATE', `A ${existing.tx.status} transaction can't be changed that way`);
  }
  if (action === 'restore') {
    if (existing.trashedAt && Date.now() - Date.parse(existing.trashedAt) > TRASH_DAYS * 86_400_000) {
      throw new ApiError(409, 'INVALID_STATE', 'This transaction has been in the trash for more than 30 days');
    }
    await checkAgainstLedger(db, context, { ...existing.tx, status: 'posted' }, await loadChart(db, context.workspaceId));
  }
  const result = await changeTransactionStatus(db, context.workspaceId, id, {
    to: transition.to,
    type: action,
    expectedVersion: existing.version,
    userId: context.userId,
  });
  await audit(db, context, transition.event, id);
  const tx = { ...existing.tx, status: transition.to };
  const trashedAt = transition.to === 'trashed' ? new Date().toISOString() : null;
  return withUndo(transactionDto({ ...existing, tx, version: result.version, trashedAt }), result.versionId);
}

/**
 * Reverts the action an undo token names (GAP-4, §9.7): a create goes to the trash, an edit
 * returns to its previous version, and a status change is reversed. The undo itself is a new
 * version, so the history shows both. Only the latest change, by the same user, within the window.
 */
export async function undo(db: Db, context: RequestContext, token: string) {
  const entry = await findUndoableVersion(db, context.workspaceId, {
    versionId: token,
    userId: context.userId,
    windowSeconds: UNDO_SECONDS + UNDO_GRACE_SECONDS,
  });
  if (!entry) throw new ApiError(409, 'UNDO_EXPIRED', 'This can no longer be undone. Use the history or the trash');
  const existing = await loadOrNotFound(db, context, entry.transactionId);

  let result;
  let updated: TransactionRecord;
  if (entry.changeType === 'edit' && entry.before && 'postings' in entry.before) {
    const before = entry.before;
    const tx: Transaction = { id: existing.tx.id, date: before.date, kind: before.kind, status: 'posted', postings: before.postings };
    if (before.refundOfId) tx.refundOfId = before.refundOfId;
    await checkAgainstLedger(db, context, tx, await loadChart(db, context.workspaceId));
    const text = { description: before.description, memo: before.memo };
    result = await replaceTransaction(db, context.workspaceId, tx, { ...text, expectedVersion: existing.version, userId: context.userId });
    updated = { ...existing, ...text, tx };
  } else if (entry.changeType === 'create' || entry.changeType === 'void' || entry.changeType === 'trash' || entry.changeType === 'restore') {
    const to: Transaction['status'] = entry.changeType === 'create' ? 'trashed' : (entry.before as { status: Transaction['status'] }).status;
    if (to === 'posted') await checkAgainstLedger(db, context, { ...existing.tx, status: 'posted' }, await loadChart(db, context.workspaceId));
    result = await changeTransactionStatus(db, context.workspaceId, existing.tx.id, {
      to,
      type: to === 'posted' ? 'restore' : to === 'voided' ? 'void' : 'trash',
      expectedVersion: existing.version,
      userId: context.userId,
    });
    updated = { ...existing, tx: { ...existing.tx, status: to }, trashedAt: to === 'trashed' ? new Date().toISOString() : null };
  } else {
    throw new ApiError(409, 'UNDO_EXPIRED', 'This change cannot be undone');
  }
  await audit(db, context, 'transaction.undone', existing.tx.id);
  return transactionDto({ ...updated, version: result.version });
}

function withUndo<T extends object>(dto: T, versionId: string) {
  return { ...dto, undo: { token: versionId, expiresInSeconds: UNDO_SECONDS } };
}

function addDaysToTimestamp(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}

function linesDto(postings: Transaction['postings']) {
  return postings.map((posting) => ({
    ledgerAccountId: posting.ledgerAccountId,
    amount_minor: posting.amount,
    mark: posting.mark ?? null,
  }));
}

function snapshotDto(snapshot: TransactionSnapshot | { status: Transaction['status'] } | null) {
  if (!snapshot || !('postings' in snapshot)) return snapshot;
  const { postings, ...rest } = snapshot;
  return { ...rest, lines: linesDto(postings) };
}

function transactionDto(record: TransactionRecord) {
  const { tx } = record;
  return {
    id: tx.id,
    date: tx.date,
    kind: tx.kind,
    status: tx.status,
    version: record.version,
    origin: record.origin,
    description: record.description,
    memo: record.memo,
    refundOfId: tx.refundOfId ?? null,
    trashedAt: record.trashedAt,
    lines: linesDto(tx.postings),
  };
}

// ---------------------------------------------------------------------------
// Summary (dashboard figures available in Stage 3)
// ---------------------------------------------------------------------------

export async function summary(db: Db, context: RequestContext, at?: string) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const today = todayIn(workspace.timezone);
  const date = at ?? today;
  if (date > today) throw new ApiError(422, 'VALIDATION_FAILED', 'The summary date cannot be in the future');
  const ledger = new Ledger(await loadChart(db, context.workspaceId), await loadTransactions(db, context.workspaceId));
  const sts = safeToSpend({ ledger, today: date, protectedReserve: workspace.protectedReserveMinor });
  return {
    at: date,
    currency: workspace.currency,
    cashBalance_minor: ledger.cashBalance(date),
    assets_minor: ledger.assets(date),
    liabilities_minor: ledger.liabilities(date),
    netWorth_minor: ledger.netWorth(date),
    safeToSpend: {
      value_minor: sts.value,
      eligibleFunds_minor: sts.elf,
      cardReserve_minor: sts.cardReserve,
      protectedReserve_minor: sts.protectedReserve,
      /** Planned items and goals arrive in Stage 5; until then they're not part of this figure. */
      scope: 'stage-3-subset',
    },
  };
}
