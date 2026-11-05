/**
 * What Safe to Spend, matching and goal money read from the plans (§7, §8, §9.5). Kept apart
 * from the services so the transaction services can use it without a circular import.
 */
import {
  normalizeDescription,
  possibleDoubleCounts,
  safeToSpend,
  suggestMatches,
  type Chart,
  type IsoDate,
  type Ledger,
  type MatchCandidate,
  type PlannedItem,
  type Transaction,
} from '@fintrack/domain';
import {
  accountDetails,
  changeAllocation,
  ensureOccurrences,
  linkedTransactionIds,
  listBatches,
  listGoals,
  loadAllocations,
  loadPlannedItems,
  type Db,
  type RequestContext,
  type TransactionRecord,
  type WorkspaceRow,
} from '@fintrack/db';
import { ApiError } from './http.ts';

export async function loadPlanState(db: Db, context: RequestContext, today: IsoDate) {
  await ensureOccurrences(db, context.workspaceId, today);
  const [planned, allocations] = [await loadPlannedItems(db, context.workspaceId), await loadAllocations(db, context.workspaceId)];
  return { planned, allocations };
}

/** The movements a transaction makes on the user's own accounts, for matching (M-1). */
export function movementsOf(tx: Transaction, chart: Chart, payer: string | null): MatchCandidate[] {
  return tx.postings
    .filter((posting) => chart.find(posting.ledgerAccountId)?.account)
    .map((posting) => ({
      date: tx.date,
      accountId: posting.ledgerAccountId,
      direction: posting.amount < 0 ? ('out' as const) : ('in' as const),
      amount: Math.abs(posting.amount),
      payer,
    }));
}

const payerOf = (record: Pick<TransactionRecord, 'payeeName' | 'description'>) => {
  const name = record.payeeName ?? record.description;
  return name ? normalizeDescription(name) : null;
};

/** The planned items an entry might be. Each is offered once, nearest first; none is applied without the user (M-5). */
export function matchSuggestions(tx: Transaction, chart: Chart, planned: readonly PlannedItem[], record: Pick<TransactionRecord, 'payeeName' | 'description'>) {
  const seen = new Set<string>();
  const suggestions = [];
  for (const movement of movementsOf(tx, chart, payerOf(record))) {
    for (const suggestion of suggestMatches(movement, planned)) {
      if (seen.has(suggestion.item.id)) continue;
      seen.add(suggestion.item.id);
      suggestions.push({
        occurrenceId: suggestion.item.id,
        name: suggestion.item.name,
        dueDate: suggestion.item.dueDate,
        amount_minor: suggestion.item.amount,
        outsideExpectedRange: suggestion.outsideExpectedRange,
      });
    }
  }
  return suggestions;
}

const plannedDto = (item: PlannedItem) => ({
  occurrenceId: item.id,
  name: item.name,
  kind: item.kind,
  dueDate: item.dueDate,
  amount_minor: item.amount,
  accountId: item.fromAccountId ?? item.toAccountId,
});

/** The value, its window, each term with its items, and the information lines (§7.10, P8). */
export async function safeToSpendFigures(db: Db, context: RequestContext, ledger: Ledger, workspace: WorkspaceRow, today: IsoDate, records: readonly TransactionRecord[]) {
  const { planned, allocations } = await loadPlanState(db, context, today);
  const sts = safeToSpend({
    ledger,
    today,
    protectedReserve: workspace.protectedReserveMinor,
    planned,
    allocations,
    countSavingsTransfers: workspace.stsCountSavingsTransfers,
  });
  const goals = new Map((await listGoals(db, context.workspaceId)).map((goal) => [goal.id, goal.name]));
  const nameOf = (id: string) => ledger.chart.find(id)?.name ?? '';

  // M-7: only entries no plan has claimed can be the double count.
  const linked = await linkedTransactionIds(db, context.workspaceId);
  const movements = records
    .filter(({ tx }) => tx.status === 'posted' && !linked.has(tx.id) && !['opening_balance', 'adjustment', 'valuation'].includes(tx.kind))
    .flatMap((record) => movementsOf(record.tx, ledger.chart, payerOf(record)).map((movement) => ({ ...movement, transactionId: record.tx.id })));
  const doubles = possibleDoubleCounts(sts.ucoItems.flatMap((item) => ('item' in item ? [item.item] : [])), movements);

  // Available credit is shown for information and never counted (§7.2).
  const details = await accountDetails(db, context.workspaceId);
  let availableCredit = 0;
  for (const account of ledger.chart.all()) {
    const limit = details.get(account.id)?.creditLimit;
    if (limit && account.account?.type === 'card' && !account.archived) availableCredit += Math.max(0, limit - Math.max(0, ledger.balance(account.id, today)));
  }
  const lastImport = (await listBatches(db, context.workspaceId)).filter((batch) => batch.status === 'confirmed').map((batch) => batch.confirmedAt).filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;

  return {
    value_minor: sts.value,
    eligibleFunds_minor: sts.elf,
    cardReserve_minor: sts.cardReserve,
    protectedReserve_minor: sts.protectedReserve,
    uco_minor: sts.uco,
    uga_minor: sts.uga,
    perDay_minor: sts.perDay,
    window: sts.window,
    elfItems: sts.elfItems.map((item) => ({ accountId: item.accountId, name: nameOf(item.accountId), amount_minor: item.amount })),
    ucoItems: sts.ucoItems.map((item) =>
      item.type === 'card_reserve'
        ? { type: item.type, name: nameOf(item.accountId), accountId: item.accountId, amount_minor: item.amount }
        : { type: item.type, ...plannedDto(item.item), amount_minor: item.amount, coveredByGoal_minor: item.coveredByGoal },
    ),
    ugaItems: sts.ugaItems.map((item) =>
      item.type === 'allocation'
        ? { type: item.type, name: goals.get(item.goalId) ?? '', accountId: item.accountId, goalId: item.goalId, amount_minor: item.amount }
        : { type: item.type, name: nameOf(item.accountId), accountId: item.accountId, amount_minor: item.amount },
    ),
    dueOnPayday: sts.dueOnPayday.map(plannedDto),
    latePayday: sts.latePayday.map(plannedDto),
    expectedIncome: sts.expectedIncome.map(plannedDto),
    possibleDoubleCounts: doubles.map((double) => ({ ...plannedDto(double.item), transactionId: double.transactionId })),
    availableCredit_minor: availableCredit,
    lastImportAt: lastImport,
  };
}

/**
 * "Use goal money" (G-P2, R5): releases up to `amount` of the goal's allocations, starting with
 * the account that paid. Runs in the caller's database transaction, so the expense and the
 * release succeed or fail together (AC-09.8). Returns what was released.
 */
export async function releaseGoalMoney(db: Db, context: RequestContext, input: { goalId: string; amount: number; paidFromAccountId: string | null; transactionId: string }): Promise<number> {
  const goals = await listGoals(db, context.workspaceId);
  if (!goals.some((goal) => goal.id === input.goalId)) throw new ApiError(422, 'INVALID_REFERENCE', 'The goal does not exist');
  const allocations = (await loadAllocations(db, context.workspaceId)).filter((allocation) => allocation.goalId === input.goalId);
  const ordered = [...allocations].sort((a, b) => Number(b.accountId === input.paidFromAccountId) - Number(a.accountId === input.paidFromAccountId));
  let left = input.amount;
  for (const allocation of ordered) {
    if (left === 0) break;
    const used = Math.min(left, allocation.amount);
    await changeAllocation(db, context.workspaceId, { goalId: input.goalId, accountId: allocation.accountId, delta: -used, event: 'use_goal_money', userId: context.userId, transactionId: input.transactionId });
    left -= used;
  }
  return input.amount - left;
}
