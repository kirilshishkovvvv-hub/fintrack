/**
 * The dashboard (FR-14) and core reports (FR-15). Same definitions as everything else (LR-16):
 * these only read the Ledger, the budgets and the plan, and keep no totals of their own.
 */
import {
  averageMonthlyExpenses,
  categoryReport,
  incomeAndExpensesByMonth,
  Ledger,
  monthRange,
  monthsBetween,
  netWorthByMonth,
  periodComparison,
  todayIn,
  type IsoDate,
} from '@fintrack/domain';
import {
  dedicatedAccounts,
  ensureOccurrences,
  getWorkspace,
  listGoals,
  listOccurrences,
  listRules,
  loadAllocations,
  loadChart,
  loadLedgerTotals,
  lockedTransactionIds,
  plannedItem,
  type Db,
  type RequestContext,
} from '@fintrack/db';
import { backedByGoal } from '@fintrack/domain';
import { getBudgets } from './budgets.ts';
import { ApiError } from './http.ts';
import { safeToSpendFigures } from './plan-state.ts';
import { recentTransactions, uncategorizedTotals } from './services.ts';

/** Months the income and net worth reports may span at once (FR-15 asks for up to 24). */
const MAX_MONTHS = 60;
const TREND_MONTHS = 12;

async function ledgerNow(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  const ledger = new Ledger(chart, await loadLedgerTotals(db, context.workspaceId));
  return { workspace, chart, ledger, today: todayIn(workspace.timezone) };
}

function monthsFor(from: string, to: string) {
  const months = monthsBetween(from, to);
  if (months.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'The start month must not be after the end month');
  if (months.length > MAX_MONTHS) throw new ApiError(422, 'VALIDATION_FAILED', `A report can cover at most ${MAX_MONTHS} months`);
  return months;
}

const shiftMonth = (month: string, by: number) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + by, 1)).toISOString().slice(0, 7);
};

/**
 * Everything on the dashboard, in one request. Point-in-time figures are as of the period's end,
 * or today if the period includes today, and the answer says which. Safe to Spend and Upcoming
 * are always as of today (FR-14).
 */
export async function getDashboard(db: Db, context: RequestContext, query: { from?: string | undefined; to?: string | undefined }) {
  const { workspace, chart, ledger, today } = await ledgerNow(db, context);
  const thisMonth = monthRange(today.slice(0, 7));
  const period = { from: query.from ?? thisMonth.from, to: query.to ?? thisMonth.to };
  if (period.from > period.to) throw new ApiError(422, 'VALIDATION_FAILED', 'from must not be after to');
  const asOf: IsoDate = period.to >= today ? today : period.to;

  await ensureOccurrences(db, context.workspaceId, today);
  const rules = await listRules(db, context.workspaceId);
  const byRule = new Map(rules.map((rule) => [rule.id, rule]));
  const occurrences = (await listOccurrences(db, context.workspaceId)).filter((occurrence) => occurrence.status === 'planned');
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = occurrences.filter((occurrence) => occurrence.dueDate <= horizon);

  const goals = await listGoals(db, context.workspaceId);
  const allocations = await loadAllocations(db, context.workspaceId);
  const backed = backedByGoal(allocations, (accountId) => ledger.balance(accountId, today));
  const dedicated = await dedicatedAccounts(db, context.workspaceId);

  const report = categoryReport(ledger, period);
  const budgetMonth = asOf.slice(0, 7);
  const budgets = await getBudgets(db, context, budgetMonth, ledger);
  const trendMonths = monthsBetween(shiftMonth(asOf.slice(0, 7), 1 - TREND_MONTHS), asOf.slice(0, 7));

  return {
    period,
    asOf,
    currency: workspace.currency,
    safeToSpend: await safeToSpendFigures(db, context, ledger, workspace, today),
    cashBalance_minor: ledger.cashBalance(asOf),
    assets_minor: ledger.assets(asOf),
    liabilities_minor: ledger.liabilities(asOf),
    netWorth_minor: ledger.netWorth(asOf),
    income_minor: ledger.income(period),
    expenses_minor: ledger.expenses(period),
    netResult_minor: ledger.netResult(period),
    spending: report.rows.map((row) => ({ categoryId: row.categoryId, name: row.name, total_minor: row.total })),
    budgets: { month: budgetMonth, items: budgets.items, total: budgets.total, overall: budgets.overall },
    upcoming: {
      count: upcoming.length,
      overdue: upcoming.filter((occurrence) => occurrence.dueDate < today).length,
      items: upcoming.slice(0, 5).map((occurrence) => {
        const item = plannedItem(occurrence, byRule.get(occurrence.ruleId)!);
        return { id: occurrence.id, name: item.name, kind: item.kind, dueDate: item.dueDate, amount_minor: item.amount, overdue: item.dueDate < today };
      }),
    },
    goals: goals
      .filter((goal) => goal.status === 'active')
      .map((goal) => {
        const accounts = dedicated.get(goal.id) ?? [];
        const allocated = allocations.filter((allocation) => allocation.goalId === goal.id).reduce((sum, allocation) => sum + allocation.amount, 0);
        const progress = goal.fundingMethod === 'dedicated' ? accounts.reduce((sum, id) => sum + Math.max(0, ledger.balance(id, today)), 0) : (backed.get(goal.id) ?? 0);
        return { id: goal.id, name: goal.name, progress_minor: progress, target_minor: goal.target, shortfall_minor: goal.fundingMethod === 'virtual' ? allocated - progress : 0 };
      }),
    recent: await recentTransactions(db, context, 5, await lockedTransactionIds(db, context.workspaceId)),
    trend: incomeAndExpensesByMonth(ledger, trendMonths).map((flow) => ({ month: flow.month, income_minor: flow.income, expenses_minor: flow.expenses, netResult_minor: flow.netResult })),
    uncategorized: await uncategorizedTotals(db, context, ledger, today.slice(0, 7)),
    hasPayday: rules.some((rule) => rule.isPayday && rule.status === 'active'),
    hasPlans: rules.some((rule) => rule.status === 'active'),
    chartHasAccounts: chart.all().some((account) => account.account),
  };
}

export async function incomeExpensesReport(db: Db, context: RequestContext, query: { from: string; to: string }) {
  const { ledger, today } = await ledgerNow(db, context);
  const flows = incomeAndExpensesByMonth(ledger, monthsFor(query.from, query.to));
  const income = flows.reduce((sum, flow) => sum + flow.income, 0);
  const expenses = flows.reduce((sum, flow) => sum + flow.expenses, 0);
  return {
    rows: flows.map((flow) => ({ month: flow.month, income_minor: flow.income, expenses_minor: flow.expenses, netResult_minor: flow.netResult })),
    total: { income_minor: income, expenses_minor: expenses, netResult_minor: income - expenses },
    averageExpenses_minor: averageMonthlyExpenses(flows, today),
    /** Net Result ÷ Income, in tenths of a percent, truncated. There's none without income. */
    savingsRateTenths: income > 0 ? Math.trunc(((income - expenses) * 1000) / income) : null,
  };
}

export async function categoriesReport(db: Db, context: RequestContext, query: { from: string; to: string; kind: 'expense' | 'income' }) {
  const { ledger } = await ledgerNow(db, context);
  const report = categoryReport(ledger, { from: query.from, to: query.to }, query.kind);
  return {
    total_minor: report.total,
    rows: report.rows.map((row) => ({
      categoryId: row.categoryId,
      name: row.name,
      total_minor: row.total,
      own_minor: row.own,
      children: row.children.map((child) => ({ categoryId: child.categoryId, name: child.name, total_minor: child.total })),
    })),
  };
}

export async function comparisonReport(db: Db, context: RequestContext, query: { aFrom: string; aTo: string; bFrom: string; bTo: string }) {
  const { ledger } = await ledgerNow(db, context);
  const report = periodComparison(ledger, { from: query.aFrom, to: query.aTo }, { from: query.bFrom, to: query.bTo });
  const dto = (line: (typeof report.totals)[number]) => ({ key: line.key, categoryId: line.categoryId, name: line.name, a_minor: line.a, b_minor: line.b, change_minor: line.change, percentTenths: line.percentTenths });
  return { totals: report.totals.map(dto), categories: report.categories.map(dto) };
}

export async function netWorthReport(db: Db, context: RequestContext, query: { from: string; to: string }) {
  const { ledger, today } = await ledgerNow(db, context);
  return {
    rows: netWorthByMonth(ledger, monthsFor(query.from, query.to), today).map((point) => ({
      month: point.month,
      asOf: point.asOf,
      assets_minor: point.assets,
      liabilities_minor: point.liabilities,
      netWorth_minor: point.netWorth,
      change_minor: point.change,
      netResult_minor: point.netResult,
      otherEffects_minor: point.otherEffects,
      identityHolds: point.identityHolds,
    })),
  };
}
