/**
 * Changing accounts, opening balances, categories, workspace settings and the marketing consent
 * (FR-03, FR-05, E-03, Annex L). Balances are never edited directly (BR-03.4).
 */
import { build, Ledger, todayIn, type Chart, type Transaction } from '@fintrack/domain';
import {
  accountDetails,
  bumpLedgerAccount,
  changeTransactionStatus,
  currentConsents,
  getWorkspace,
  hasTransactions,
  insertTransaction,
  listReconciliations,
  loadChart,
  loadTransactionRecords,
  recordAuditEvent,
  recordConsents,
  replaceTransaction,
  setCategoryParent,
  setDisplayOrder,
  setOpeningDate,
  updateAccountFields,
  updateWorkspaceSettings,
  uuidv7,
  type Db,
  type RequestContext,
  type TransactionRecord,
} from '@fintrack/db';
import type { z } from 'zod';
import { ApiError } from './http.ts';
import { unlock } from './reconciliation.ts';
import type { openingBody, updateAccountBody, updateCategoryBody, updateWorkspaceBody } from './schemas.ts';
import { accountDto, checkAgainstLedger, CLASS_BY_TYPE, categoryDto, workspaceDto } from './services.ts';

function event(db: Db, context: RequestContext, type: string, objectType: string, objectId: string) {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType, objectId });
}

function accountOr404(chart: Chart, id: string) {
  const account = chart.find(id);
  if (!account?.account) throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  return account;
}

/** An account's single opening-balance transaction, if it has one (BR-03.2). Purged ones are gone. */
const openingOf = (records: readonly TransactionRecord[], id: string) =>
  records.find(({ tx }) => tx.kind === 'opening_balance' && tx.postings.some((p) => p.ledgerAccountId === id));

const signedFor = (chart: Chart, id: string, raw: number) => (chart.get(id).kind === 'liability' ? -raw : raw);

/** One account with what only its edit screen needs. */
export async function accountDetail(db: Db, context: RequestContext, id: string) {
  const chart = await loadChart(db, context.workspaceId);
  const account = accountOr404(chart, id);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const workspace = await getWorkspace(db, context.workspaceId);
  const details = (await accountDetails(db, context.workspaceId)).get(id)!;
  const opening = openingOf(records, id);
  const openingPosted = opening?.tx.status === 'posted' ? opening.tx.postings.find((p) => p.ledgerAccountId === id)!.amount : 0;
  const reconciliations = await listReconciliations(db, context.workspaceId, id);
  return {
    ...accountDto(new Ledger(chart, records.map((record) => record.tx)), account, todayIn(workspace.timezone)),
    institution: details.institution,
    creditLimit_minor: details.creditLimit,
    notes: details.notes,
    loanPrincipal_minor: details.loanPrincipal,
    loanRate_bp: details.loanRateBp,
    loanInstallment_minor: details.loanInstallment,
    loanTerm_months: details.loanTermMonths,
    dedicatedToGoal: details.dedicatedGoalId !== null,
    version: details.version,
    openingAmount_minor: signedFor(chart, id, openingPosted),
    /** A change to the opening balance would break these (E-03). */
    openingHeldByReconciliation: opening !== undefined && reconciliations.some((row) => row.status === 'completed' && row.transactionIds.includes(opening.tx.id)),
  };
}

/** Rename, type within the class (BR-03.6), spendable (BR-03.7), card reserve and the optional fields (BR-03.1). */
export async function changeAccount(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof updateAccountBody>) {
  const chart = await loadChart(db, context.workspaceId);
  const account = accountOr404(chart, id);
  const info = account.account!;
  const details = (await accountDetails(db, context.workspaceId)).get(id)!;
  const type = input.type ?? info.type;
  if (CLASS_BY_TYPE[type] !== info.class) throw new ApiError(422, 'VALIDATION_FAILED', 'An account type can change only within the same class (BR-03.6)');
  const spendable = input.spendable ?? info.spendable;
  if (spendable && info.class !== 'cash') throw new ApiError(422, 'VALIDATION_FAILED', 'Only cash accounts can be spendable (BR-03.7)');
  if (spendable && details.dedicatedGoalId) throw new ApiError(422, 'VALIDATION_FAILED', 'An account dedicated to a goal cannot be spendable (BR-03.7)');
  const isCard = type === 'card';
  if (!isCard && input.cardReserve) throw new ApiError(422, 'VALIDATION_FAILED', 'Only credit cards have a card reserve (LR-18)');
  if (!isCard && input.creditLimit_minor) throw new ApiError(422, 'VALIDATION_FAILED', 'Only credit cards have a credit limit (BR-03.1)');
  const version = await bumpLedgerAccount(db, context.workspaceId, id, expectedVersion, input.name);
  if (version === null) throw new ApiError(409, 'VERSION_CONFLICT', 'The account was changed since you opened it');
  await updateAccountFields(db, context.workspaceId, id, {
    type,
    spendable,
    cardReserve: isCard && (input.cardReserve ?? info.cardReserve),
    institution: input.institution === undefined ? details.institution : input.institution || null,
    creditLimit: !isCard ? null : input.creditLimit_minor === undefined ? details.creditLimit : input.creditLimit_minor,
    notes: input.notes === undefined ? details.notes : input.notes || null,
    // BR-10.5: for information only, and only on a loan.
    loanPrincipal: type !== 'loan' ? null : input.loanPrincipal_minor === undefined ? details.loanPrincipal : input.loanPrincipal_minor,
    loanRateBp: type !== 'loan' ? null : input.loanRate_bp === undefined ? details.loanRateBp : input.loanRate_bp,
    loanInstallment: type !== 'loan' ? null : input.loanInstallment_minor === undefined ? details.loanInstallment : input.loanInstallment_minor,
    loanTermMonths: type !== 'loan' ? null : input.loanTerm_months === undefined ? details.loanTermMonths : input.loanTerm_months,
  });
  await event(db, context, 'account.updated', 'account', id);
  return accountDetail(db, context, id);
}

/**
 * Changes the opening balance or date (BR-03.2, E-03). The transaction is replaced in one step,
 * so balances shift by the difference, and only the OBE source of Net Worth moves. At 0 it's
 * voided, since a transaction can't have empty postings. Reconciliations holding it are broken:
 * the lock (AC-18.2) covers the date as well, and a statement can't stay true of a date it now precedes.
 */
export async function changeOpening(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof openingBody>) {
  const chart = await loadChart(db, context.workspaceId);
  const account = accountOr404(chart, id);
  const info = account.account!;
  if (account.archived) throw new ApiError(409, 'ARCHIVE_BLOCKED', 'Unarchive the account first');
  const workspace = await getWorkspace(db, context.workspaceId);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const existing = openingOf(records, id);
  const currentAmount = existing?.tx.status === 'posted' ? signedFor(chart, id, existing.tx.postings.find((p) => p.ledgerAccountId === id)!.amount) : 0;
  const date = input.openingDate ?? info.openingDate;
  const amount = input.openingAmount_minor ?? currentAmount;

  if (date > todayIn(workspace.timezone)) throw new ApiError(422, 'VALIDATION_FAILED', 'The opening date cannot be in the future (LR-04)');
  // Voided and trashed ones count: they could be restored, and would then predate the account.
  const earliest = records
    .filter(({ tx }) => tx.id !== existing?.tx.id && tx.postings.some((p) => p.ledgerAccountId === id))
    .reduce<string | null>((first, { tx }) => (first === null || tx.date < first ? tx.date : first), null);
  if (earliest !== null && date > earliest) {
    throw new ApiError(422, 'OPENING_DATE_TOO_LATE', 'The opening date cannot be later than a transaction on this account (LR-04)', { earliest });
  }

  const version = await bumpLedgerAccount(db, context.workspaceId, id, expectedVersion);
  if (version === null) throw new ApiError(409, 'VERSION_CONFLICT', 'The account was changed since you opened it');

  if (existing) {
    const held = (await listReconciliations(db, context.workspaceId, id)).filter((row) => row.status === 'completed' && row.transactionIds.includes(existing.tx.id));
    // Newest first, and unlocking one also unlocks the later ones, so the oldest covers them all.
    if (held.length > 0 && (amount !== currentAmount || date !== existing.tx.date)) await unlock(db, context, held.at(-1)!.id);
  }

  // The database refuses a posting dated before the account opens, so an earlier date goes first.
  const previousDate = info.openingDate;
  if (date < previousDate) await setOpeningDate(db, context.workspaceId, id, date);
  info.openingDate = date;
  const tx: Transaction | null = build.openingBalance(chart, { id: existing?.tx.id ?? uuidv7(), date, accountId: id, amount });
  if (tx) await checkAgainstLedger(db, context, tx, chart);

  if (!existing) {
    if (tx) await insertTransaction(db, context.workspaceId, tx, { origin: 'system', userId: context.userId });
  } else if (!tx) {
    if (existing.tx.status === 'posted') {
      await changeTransactionStatus(db, context.workspaceId, existing.tx.id, { to: 'voided', type: 'void', expectedVersion: existing.version, userId: context.userId });
    }
  } else if (amount !== currentAmount || date !== existing.tx.date || existing.tx.status !== 'posted') {
    const restored =
      existing.tx.status === 'posted'
        ? existing.version
        : (await changeTransactionStatus(db, context.workspaceId, existing.tx.id, { to: 'posted', type: 'restore', expectedVersion: existing.version, userId: context.userId })).version;
    await replaceTransaction(db, context.workspaceId, tx, { description: existing.description, memo: existing.memo, payeeId: existing.payeeId ?? null, expectedVersion: restored, userId: context.userId });
  }
  if (date > previousDate) await setOpeningDate(db, context.workspaceId, id, date);
  await event(db, context, 'account.opening_changed', 'account', id);
  return accountDetail(db, context, id);
}

export async function orderAccounts(db: Db, context: RequestContext, ids: readonly string[]) {
  const chart = await loadChart(db, context.workspaceId);
  for (const id of ids) accountOr404(chart, id);
  await setDisplayOrder(db, context.workspaceId, 'accounts', ids);
  return { ok: true };
}

export async function orderCategories(db: Db, context: RequestContext, ids: readonly string[]) {
  const chart = await loadChart(db, context.workspaceId);
  for (const id of ids) if (!chart.find(id)?.category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  await setDisplayOrder(db, context.workspaceId, 'categories', ids);
  return { ok: true };
}

/** Rename or move, within two levels and one kind (BR-05.1). The kind itself never changes here. */
export async function changeCategory(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof updateCategoryBody>) {
  const chart = await loadChart(db, context.workspaceId);
  const category = chart.find(id);
  if (!category?.category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  if (input.parentId) {
    const parent = chart.find(input.parentId);
    if (input.parentId === id || !parent?.category) throw new ApiError(422, 'INVALID_REFERENCE', 'The parent category does not exist');
    if (parent.kind !== category.kind) throw new ApiError(422, 'VALIDATION_FAILED', 'A subcategory must have the same kind as its parent');
    if (parent.category.parentId) throw new ApiError(422, 'VALIDATION_FAILED', 'Categories have two levels (BR-05.1)');
    if (parent.archived) throw new ApiError(409, 'ARCHIVE_BLOCKED', `Unarchive ${parent.name} first`);
    if (chart.all().some((other) => other.category?.parentId === id)) throw new ApiError(422, 'VALIDATION_FAILED', 'Categories have two levels (BR-05.1)');
  }
  const version = await bumpLedgerAccount(db, context.workspaceId, id, expectedVersion, input.name);
  if (version === null) throw new ApiError(409, 'VERSION_CONFLICT', 'The category was changed since you opened it');
  if (input.parentId !== undefined) await setCategoryParent(db, context.workspaceId, id, input.parentId);
  await event(db, context, 'category.updated', 'category', id);
  const parentId = input.parentId === undefined ? category.category.parentId : input.parentId;
  const moved = { ...category, name: input.name ?? category.name, category: parentId ? { parentId } : {} };
  return categoryDto(moved, { version });
}

export async function workspaceSettings(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  return { ...workspaceDto(workspace), currencyLocked: await hasTransactions(db, context.workspaceId) };
}

export async function changeWorkspace(db: Db, context: RequestContext, expectedVersion: number, input: z.infer<typeof updateWorkspaceBody>) {
  const workspace = await getWorkspace(db, context.workspaceId);
  if (input.currency && input.currency !== workspace.currency && (await hasTransactions(db, context.workspaceId))) {
    throw new ApiError(409, 'CURRENCY_LOCKED', 'The currency cannot change once transactions exist (BR-23.2)');
  }
  const changed = await updateWorkspaceSettings(db, context.workspaceId, {
    name: input.name,
    timezone: input.timezone,
    protectedReserveMinor: input.protectedReserve_minor,
    stsCountSavingsTransfers: input.stsCountSavingsTransfers,
    currency: input.currency,
    expectedVersion,
  });
  if (!changed) throw new ApiError(409, 'VERSION_CONFLICT', 'The settings were changed since you opened them');
  await event(db, context, 'workspace.updated', 'workspace', context.workspaceId);
  return workspaceSettings(db, context);
}

/** The optional consents the user can change (Annex L item 6). Each change is a new record. */
export async function myConsents(db: Db, context: RequestContext) {
  const consents = await currentConsents(db, context.userId);
  return { marketing: consents.marketing?.accepted ?? false };
}

export async function changeMarketingConsent(db: Db, context: RequestContext, accepted: boolean) {
  await recordConsents(db, context.userId, [{ document: 'marketing', version: '1', accepted }]);
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'consent.changed', objectType: 'consent' });
  return { marketing: accepted };
}
