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
  createWorkspace,
  getWorkspace,
  insertLedgerAccount,
  insertTransaction,
  loadChart,
  loadTransactions,
  recordAuditEvent,
  uuidv7,
  workspaceIdsForUser,
  type Db,
  type RequestContext,
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

function buildFromIntention(chart: Chart, id: string, input: TransactionInput): Transaction {
  switch (input.kind) {
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

async function record(db: Db, context: RequestContext, tx: Transaction, chart: Chart, meta: { description?: string | undefined; memo?: string | undefined }) {
  const workspace = await getWorkspace(db, context.workspaceId);
  if (tx.refundOfId) {
    const original = (await loadTransactions(db, context.workspaceId)).find((candidate) => candidate.id === tx.refundOfId);
    if (!original) throw new ApiError(422, 'INVALID_REFERENCE', 'The original transaction does not exist');
  }
  validateTransaction(tx, chart, { today: todayIn(workspace.timezone) });
  await insertTransaction(db, context.workspaceId, tx, {
    origin: 'manual',
    userId: context.userId,
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.memo ? { memo: meta.memo } : {}),
  });
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'transaction.created', objectType: 'transaction', objectId: tx.id });
  return transactionDto(tx);
}

export async function recordTransaction(db: Db, context: RequestContext, input: TransactionInput) {
  const chart = await loadChart(db, context.workspaceId);
  return record(db, context, buildFromIntention(chart, uuidv7(), input), chart, input);
}

export async function recordTransfer(db: Db, context: RequestContext, input: TransferInput) {
  const chart = await loadChart(db, context.workspaceId);
  const base = { id: uuidv7(), date: input.date, fromId: input.fromAccountId, toId: input.toAccountId, amount: input.amount_minor };
  const tx = input.fee ? build.transfer({ ...base, fee: { categoryId: input.fee.categoryId, amount: input.fee.amount_minor } }) : build.transfer(base);
  return record(db, context, tx, chart, input);
}

export async function listTransactions(db: Db, context: RequestContext, period: { from: string; to: string }) {
  return (await loadTransactions(db, context.workspaceId))
    .filter((tx) => tx.date >= period.from && tx.date <= period.to)
    .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1))
    .map(transactionDto);
}

export async function getTransaction(db: Db, context: RequestContext, id: string) {
  const tx = (await loadTransactions(db, context.workspaceId)).find((candidate) => candidate.id === id);
  if (!tx) throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  return transactionDto(tx);
}

function transactionDto(tx: Transaction) {
  return {
    id: tx.id,
    date: tx.date,
    kind: tx.kind,
    status: tx.status,
    refundOfId: tx.refundOfId ?? null,
    lines: tx.postings.map((posting) => ({
      ledgerAccountId: posting.ledgerAccountId,
      amount_minor: posting.amount,
      mark: posting.mark ?? null,
    })),
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
