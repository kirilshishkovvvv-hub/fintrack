/**
 * Monthly budgets (FR-07) and the debt overview (FR-10). Budgets never post and never reach
 * Safe to Spend (BR-07.9, R7). Spent comes from the ledger, nothing keeps a running total.
 */
import {
  formatUtilization,
  Ledger,
  scheduledInMonth,
  thresholdReached,
  todayIn,
  utilizationTenths,
  type Chart,
} from '@fintrack/domain';
import {
  ensureOccurrences,
  fireBudgetAlert,
  getWorkspace,
  accountDetails,
  listBudgetAlerts,
  listBudgetLimits,
  loadChart,
  loadPlannedItems,
  loadTransactions,
  recordAuditEvent,
  setBudgetLimit,
  type BudgetLimitRow,
  type Db,
  type RequestContext,
} from '@fintrack/db';
import { ApiError } from './http.ts';

const firstOf = (month: string) => `${month}-01`;

const nextMonth = (month: string) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
};

/** BR-07.1: the limit for a month is the latest row at or before it. */
function limitFor(rows: readonly BudgetLimitRow[], categoryId: string | null, month: string): BudgetLimitRow | null {
  const first = firstOf(month);
  const found = rows.filter((row) => row.categoryId === categoryId && row.effectiveMonth <= first).at(-1);
  return found && found.limit !== null ? found : null;
}

/** AC-07.2: a threshold fires once per budget and month. Going down and up again adds nothing (AC-07.3). */
export async function evaluateBudgetAlerts(db: Db, context: RequestContext, ledger: Ledger, month: string): Promise<void> {
  const limits = await listBudgetLimits(db, context.workspaceId);
  for (const categoryId of new Set(limits.map((row) => row.categoryId))) {
    if (!categoryId) continue;
    const row = limitFor(limits, categoryId, month);
    if (!row) continue;
    const spent = ledger.budgetSpent(categoryId, month);
    if (spent <= 0) continue;
    for (const threshold of row.thresholds) {
      if (thresholdReached(spent, row.limit!, threshold)) await fireBudgetAlert(db, context.workspaceId, categoryId, firstOf(month), threshold);
    }
  }
}

export async function getBudgets(db: Db, context: RequestContext, month: string) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const today = todayIn(workspace.timezone);
  await ensureOccurrences(db, context.workspaceId, today);
  const chart = await loadChart(db, context.workspaceId);
  const ledger = new Ledger(chart, await loadTransactions(db, context.workspaceId));
  await evaluateBudgetAlerts(db, context, ledger, month);
  const limits = await listBudgetLimits(db, context.workspaceId);
  const planned = await loadPlannedItems(db, context.workspaceId);
  const alerts = await listBudgetAlerts(db, context.workspaceId, firstOf(month));

  const rows = [];
  for (const account of chart.all()) {
    if (!account.category || account.kind !== 'expense') continue;
    const row = limitFor(limits, account.id, month);
    if (!row) continue;
    const limit = row.limit!;
    const spent = ledger.budgetSpent(account.id, month);
    const tenths = utilizationTenths(spent, limit);
    rows.push({
      categoryId: account.id,
      name: account.name,
      archived: account.archived ?? false,
      limit_minor: limit,
      spent_minor: spent,
      /** Shown apart, never added to Spent (BR-07.5). */
      scheduled_minor: scheduledInMonth(planned, new Set(chart.categorySubtree(account.id)), month, today),
      remaining_minor: limit - spent,
      utilization: formatUtilization(tenths),
      over: spent > limit,
      netRefund: spent < 0,
      thresholds: row.thresholds,
      /** Fired at some point this month, whatever Spent is now (AC-07.3). */
      alerted: alerts.filter((alert) => alert.categoryId === account.id).map((alert) => alert.threshold).sort((a, b) => a - b),
    });
  }
  const totalLimit = rows.reduce((sum, row) => sum + row.limit_minor, 0);
  const overall = limitFor(limits, null, month);
  return {
    month,
    items: rows,
    total: {
      limit_minor: totalLimit,
      spent_minor: rows.reduce((sum, row) => sum + row.spent_minor, 0),
    },
    overall: overall
      ? {
          limit_minor: overall.limit!,
          spent_minor: ledger.expenses({ from: firstOf(month), to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10) }),
          /** BR-07.3: a warning, and nothing is blocked. */
          budgetsExceedIt: totalLimit > overall.limit!,
        }
      : null,
  };
}

function branchConflict(chart: Chart, categoryId: string, limits: readonly BudgetLimitRow[], month: string): boolean {
  const parent = chart.get(categoryId).category?.parentId;
  const relatives = chart.all().filter((other) => other.category && (other.id === parent || other.category.parentId === categoryId));
  return relatives.some((relative) => limitFor(limits, relative.id, month) !== null || limits.some((row) => row.categoryId === relative.id && row.effectiveMonth > firstOf(month) && row.limit !== null));
}

/** BR-07.1: a change applies to this month, and optionally to all later months. A null limit means no budget. */
export async function setBudget(db: Db, context: RequestContext, categoryId: string | null, month: string, input: { limit_minor: number | null; thresholds?: number[] | undefined; applyForward?: boolean | undefined }) {
  const chart = await loadChart(db, context.workspaceId);
  const limits = await listBudgetLimits(db, context.workspaceId);
  if (categoryId) {
    const category = chart.find(categoryId);
    if (!category?.category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
    if (category.kind !== 'expense') throw new ApiError(422, 'VALIDATION_FAILED', 'Budgets are for expense categories (BR-07.1)');
    if (input.limit_minor !== null && branchConflict(chart, categoryId, limits, month)) {
      throw new ApiError(409, 'BUDGET_BRANCH_CONFLICT', 'A category and its subcategories cannot both have a budget (BR-07.2)');
    }
  }
  const current = limitFor(limits, categoryId, month);
  const thresholds = input.thresholds ?? current?.thresholds ?? [80, 100];
  const applyForward = input.applyForward ?? true;
  if (!applyForward) {
    // This month only: whatever applied before picks up again next month, unless a row is already there.
    const next = nextMonth(month);
    const hasNext = limits.some((row) => row.categoryId === categoryId && row.effectiveMonth === firstOf(next));
    if (!hasNext) await setBudgetLimit(db, context.workspaceId, categoryId, firstOf(next), current?.limit ?? null, current?.thresholds ?? thresholds, false);
  }
  await setBudgetLimit(db, context.workspaceId, categoryId, firstOf(month), input.limit_minor, thresholds, applyForward);
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'budget.changed', objectType: 'budget', ...(categoryId ? { objectId: categoryId } : {}) });
  return getBudgets(db, context, month);
}

/** FR-10: total liabilities, each one's change over the period, upcoming payments and interest paid. */
export async function getDebts(db: Db, context: RequestContext, period: { from: string; to: string }) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const today = todayIn(workspace.timezone);
  await ensureOccurrences(db, context.workspaceId, today);
  const chart = await loadChart(db, context.workspaceId);
  const ledger = new Ledger(chart, await loadTransactions(db, context.workspaceId));
  const details = await accountDetails(db, context.workspaceId);
  const before = new Date(Date.parse(`${period.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const planned = await loadPlannedItems(db, context.workspaceId);
  const liabilities = chart.all().filter((account) => account.account && account.kind === 'liability' && !account.archived);
  const owed = (id: string, on: string) => ledger.balance(id, on);
  const until = period.to < today ? today : period.to;
  const interestCategories = chart.all().filter((account) => account.category && account.kind === 'expense' && /^interest/i.test(account.name));
  const byCategory = ledger.expensesByCategory(period);
  return {
    from: period.from,
    to: period.to,
    total_minor: liabilities.reduce((sum, account) => sum + owed(account.id, until), 0),
    items: liabilities.map((account) => {
      const limit = details.get(account.id)?.creditLimit ?? null;
      return {
        accountId: account.id,
        name: account.name,
        type: account.account!.type,
        owed_minor: owed(account.id, until),
        change_minor: owed(account.id, period.to) - owed(account.id, before),
        creditLimit_minor: limit,
        /** For information only: it never counts as money (§7.2). */
        availableCredit_minor: limit === null ? null : Math.max(0, limit - Math.max(0, owed(account.id, until))),
      };
    }),
    upcoming: planned
      .filter((item) => item.toAccountId && chart.find(item.toAccountId)?.kind === 'liability')
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
      .slice(0, 12)
      .map((item) => ({ occurrenceId: item.id, name: item.name, dueDate: item.dueDate, amount_minor: item.amount, accountId: item.toAccountId })),
    interestPaid_minor: interestCategories.reduce((sum, account) => sum + (byCategory.get(account.id) ?? 0), 0),
  };
}
