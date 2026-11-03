/**
 * Reconciliation and quick balance updates (FR-18, E-36, E-37, E-43). The user states what the
 * statement or the wallet says and ticks what it shows; the server works out every figure.
 */
import { balanceUpdateDelta, build, Ledger, reconcile, todayIn, type Transaction } from '@fintrack/domain';
import {
  getWorkspace,
  insertReconciliation,
  insertTransaction,
  listReconciliations,
  loadChart,
  loadTransactionRecords,
  recordAuditEvent,
  supersedeBroken,
  unlockReconciliation,
  uuidv7,
  type Db,
  type ReconciliationRow,
  type RequestContext,
  type TransactionRecord,
} from '@fintrack/db';
import type { z } from 'zod';
import { ApiError } from './http.ts';
import type { balanceUpdateBody, reconciliationBody, reconciliationPreviewBody } from './schemas.ts';
import { audit, checkAgainstLedger, transactionDto, withUndo } from './services.ts';

type PreviewInput = z.infer<typeof reconciliationPreviewBody>;
type ReconcileInput = z.infer<typeof reconciliationBody>;

/** A reconciliation is earlier than another if its statement is, or the same statement was finished first. */
const before = (a: ReconciliationRow, b: ReconciliationRow) =>
  a.statementDate < b.statementDate || (a.statementDate === b.statementDate && a.completedAt < b.completedAt);

/**
 * The transactions a reconciliation counts as cleared: its own items plus those of every earlier
 * reconciliation of the account that hasn't been redone. Used for the stored ones and a new one.
 */
function clearedBy(target: ReconciliationRow, all: ReconciliationRow[]): Set<string> {
  const ids = new Set(target.transactionIds);
  for (const other of all) {
    if (other.id !== target.id && other.accountId === target.accountId && other.status !== 'superseded' && before(other, target)) {
      for (const id of other.transactionIds) ids.add(id);
    }
  }
  return ids;
}

async function loadState(db: Db, context: RequestContext, accountId: string) {
  // One connection runs one query at a time, so these are awaited in turn.
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const reconciliations = await listReconciliations(db, context.workspaceId);
  const account = chart.find(accountId);
  if (!account?.account) throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  const ledger = new Ledger(chart, records.map((record) => record.tx));
  return { today: todayIn(workspace.timezone), chart, ledger, records, reconciliations, account };
}

type State = Awaited<ReturnType<typeof loadState>>;

/** The account's side of a transaction, as the user sees the balance. */
function effectOn(state: State, tx: Transaction): number {
  const raw = tx.postings.filter((p) => p.ledgerAccountId === state.account.id).reduce((sum, p) => sum + p.amount, 0);
  return state.account.kind === 'liability' ? -raw : raw;
}

/** Works out the figures for a statement and the ticked items, and checks every rule on the way. */
function evaluate(state: State, input: PreviewInput) {
  const { account } = state;
  if (account.archived) throw new ApiError(409, 'INVALID_STATE', 'Unarchive the account to reconcile it');
  if (input.statementDate > state.today) throw new ApiError(422, 'VALIDATION_FAILED', 'The statement date cannot be in the future');
  if (input.statementDate < account.account!.openingDate) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'The statement date is before the account was opened');
  }
  const mine = state.reconciliations.filter((row) => row.accountId === account.id);
  const latest = mine.find((row) => row.status === 'completed');
  if (latest && input.statementDate < latest.statementDate) {
    throw new ApiError(409, 'INVALID_STATE', `This account is already reconciled up to ${latest.statementDate}`);
  }
  const alreadyCleared = new Set(mine.filter((row) => row.status === 'completed').flatMap((row) => row.transactionIds));
  const candidates = state.records.filter(
    (record) =>
      record.tx.status === 'posted' &&
      record.tx.date <= input.statementDate &&
      !alreadyCleared.has(record.tx.id) &&
      record.tx.postings.some((p) => p.ledgerAccountId === account.id),
  );
  const candidateIds = new Set(candidates.map((record) => record.tx.id));
  const unknown = input.transactionIds.filter((id) => !candidateIds.has(id));
  if (unknown.length > 0) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Some ticked items cannot be part of this reconciliation', { transactionIds: unknown });
  }
  // An opening balance always counts as cleared (E-01).
  const automatic = candidates.filter((record) => record.tx.kind === 'opening_balance').map((record) => record.tx.id);
  const ticked = new Set([...input.transactionIds, ...automatic]);
  const figures = reconcile(state.ledger, {
    accountId: account.id,
    statementBalance: input.statementBalance_minor,
    cleared: new Set([...alreadyCleared, ...ticked]),
  });
  return { candidates, automatic: new Set(automatic), ticked, figures, alreadyCleared };
}

function figuresDto(figures: ReturnType<typeof reconcile>) {
  return {
    cleared_minor: figures.cleared,
    statement_minor: figures.statement,
    difference_minor: figures.difference,
    adjustment_minor: figures.adjustment,
  };
}

/** The reconcile screen: unreconciled items up to the statement date, and the figures for the ticks so far. */
export async function previewReconciliation(db: Db, context: RequestContext, input: PreviewInput) {
  const state = await loadState(db, context, input.accountId);
  const result = evaluate(state, input);
  return {
    accountId: input.accountId,
    statementDate: input.statementDate,
    ...figuresDto(result.figures),
    previouslyCleared_minor: state.ledger.clearedBalance(input.accountId, result.alreadyCleared),
    items: result.candidates
      .sort((a, b) => (a.tx.date === b.tx.date ? (a.tx.id < b.tx.id ? -1 : 1) : a.tx.date < b.tx.date ? -1 : 1))
      .map((record: TransactionRecord) => ({
        ...transactionDto(record),
        effect_minor: effectOn(state, record.tx),
        ticked: result.ticked.has(record.tx.id),
        automatic: result.automatic.has(record.tx.id),
      })),
  };
}

/**
 * Finishes a reconciliation (FR-18): the ticked items and any adjustment become reconciled and
 * locked, in one database transaction. A remaining difference needs an explicit adjustment,
 * to ADJ by default or to a category the user picked (E-36, E-37, AC-18.1).
 */
export async function completeReconciliation(db: Db, context: RequestContext, input: ReconcileInput) {
  const state = await loadState(db, context, input.accountId);
  const { figures, ticked } = evaluate(state, input);
  const items = [...ticked];
  let adjustmentId: string | null = null;
  if (figures.difference !== 0) {
    if (!input.adjustment) {
      throw new ApiError(422, 'RECONCILIATION_DIFFERENCE', 'Tick the missing items, fix transactions, or post an adjustment', figuresDto(figures));
    }
    const counter = input.adjustment.categoryId;
    if (counter && !state.chart.find(counter)?.category) throw new ApiError(422, 'INVALID_REFERENCE', 'The category does not exist');
    const adjustment = build.adjustment(state.chart, {
      id: uuidv7(),
      date: input.statementDate,
      accountId: input.accountId,
      delta: figures.adjustment,
      ...(counter ? { counterId: counter } : {}),
    });
    await checkAgainstLedger(db, context, adjustment, state.chart);
    await insertTransaction(db, context.workspaceId, adjustment, { origin: 'system', userId: context.userId });
    await audit(db, context, 'transaction.created', adjustment.id);
    items.push(adjustment.id);
    adjustmentId = adjustment.id;
  }
  const id = uuidv7();
  await supersedeBroken(db, context.workspaceId, input.accountId, input.statementDate);
  await insertReconciliation(db, context.workspaceId, {
    id,
    accountId: input.accountId,
    statementDate: input.statementDate,
    statementBalance: input.statementBalance_minor,
    adjustmentTransactionId: adjustmentId,
    transactionIds: items,
    userId: context.userId,
  });
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'reconciliation.completed', objectType: 'reconciliation', objectId: id });
  return (await listReconciliationsDto(db, context, input.accountId)).find((row) => row.id === id)!;
}

/** Reconciliation history (FR-18), with each one's figures as the ledger stands now. A broken one shows its difference (GT-42). */
export async function listReconciliationsDto(db: Db, context: RequestContext, accountId?: string) {
  const chart = await loadChart(db, context.workspaceId);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const all = await listReconciliations(db, context.workspaceId);
  const ledger = new Ledger(chart, records.map((record) => record.tx));
  return all
    .filter((row) => !accountId || row.accountId === accountId)
    .map((row) => ({
      id: row.id,
      accountId: row.accountId,
      statementDate: row.statementDate,
      status: row.status,
      adjustmentTransactionId: row.adjustmentTransactionId,
      completedAt: row.completedAt,
      unlockedAt: row.unlockedAt,
      transactionIds: row.transactionIds,
      ...figuresDto(reconcile(ledger, { accountId: row.accountId, statementBalance: row.statementBalance, cleared: clearedBy(row, all) })),
    }));
}

/**
 * Unlocks a reconciliation so its items can be changed (FR-18, AC-18.2). Later reconciliations
 * of the same account build on its items, so they're unlocked too. Each unlock is audited, and
 * each reconciliation stays broken until the account is reconciled again.
 */
export async function unlock(db: Db, context: RequestContext, id: string) {
  const all = await listReconciliations(db, context.workspaceId);
  const target = all.find((row) => row.id === id);
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Reconciliation not found');
  if (target.status !== 'completed') throw new ApiError(409, 'INVALID_STATE', 'This reconciliation is not locked');
  const affected = all.filter((row) => row.accountId === target.accountId && row.status === 'completed' && (row.id === id || before(target, row)));
  for (const row of affected) {
    await unlockReconciliation(db, context.workspaceId, row.id, context.userId);
    await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'reconciliation.unlocked', objectType: 'reconciliation', objectId: row.id });
  }
  const unlocked = new Set(affected.map((row) => row.id));
  return { items: (await listReconciliationsDto(db, context, target.accountId)).filter((row) => unlocked.has(row.id)) };
}

/**
 * Quick balance update (FR-18): the user enters the actual value and the server posts the
 * difference, as an adjustment for cash (to ADJ, or to a category for "I spent it", E-37) or as a
 * valuation for investments and other assets (E-43). Cards and loans are reconciled instead.
 */
export async function updateBalance(db: Db, context: RequestContext, accountId: string, input: z.infer<typeof balanceUpdateBody>) {
  const state = await loadState(db, context, accountId);
  const accountClass = state.account.account!.class;
  if (accountClass === 'liability') throw new ApiError(422, 'VALIDATION_FAILED', 'Reconcile a card or loan against its statement instead');
  if (accountClass !== 'cash' && input.categoryId) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'A change in value is a valuation, not spending (LR-12)');
  }
  if (input.categoryId && !state.chart.find(input.categoryId)?.category) {
    throw new ApiError(422, 'INVALID_REFERENCE', 'The category does not exist');
  }
  const delta = balanceUpdateDelta(state.ledger, { accountId, date: input.date, actual: input.actual_minor });
  if (delta === 0) return { transaction: null };
  const base = { id: uuidv7(), date: input.date, accountId, delta };
  const tx = accountClass === 'cash'
    ? build.adjustment(state.chart, input.categoryId ? { ...base, counterId: input.categoryId } : base)
    : build.valuation(state.chart, base);
  await checkAgainstLedger(db, context, tx, state.chart);
  const { versionId } = await insertTransaction(db, context.workspaceId, tx, { origin: 'system', userId: context.userId });
  await audit(db, context, 'transaction.created', tx.id);
  return {
    transaction: withUndo(transactionDto({ tx, origin: 'system', version: 1, trashedAt: null, description: null, memo: null }), versionId),
  };
}
