/**
 * Reports (FR-15): every figure comes from the Ledger's canonical definitions (§2.3, LR-16), so a
 * report can't disagree with the dashboard. Nothing here keeps a total of its own.
 */
import { addDays, monthRange, type IsoDate } from './dates.ts';
import type { Ledger, Period } from './metrics.ts';
import type { Cents } from './money.ts';

/** Every "YYYY-MM" from one month to another, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const [fromYear, fromMonth] = from.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = to.split('-').map(Number) as [number, number];
  const months: string[] = [];
  for (let index = 0; (fromYear + Math.floor((fromMonth - 1 + index) / 12)) * 12 + (fromMonth - 1 + index) % 12 <= toYear * 12 + toMonth - 1; index += 1) {
    months.push(new Date(Date.UTC(fromYear, fromMonth - 1 + index, 1)).toISOString().slice(0, 7));
  }
  return months;
}

export interface MonthFlow {
  month: string;
  income: Cents;
  expenses: Cents;
  netResult: Cents;
}

export function incomeAndExpensesByMonth(ledger: Ledger, months: readonly string[]): MonthFlow[] {
  return months.map((month) => {
    const period = monthRange(month);
    return { month, income: ledger.income(period), expenses: ledger.expenses(period), netResult: ledger.netResult(period) };
  });
}

/**
 * Average monthly expenses: the total over the full months in the range. A partial current month
 * is left out unless it's the only one chosen (FR-15, GT-57 b).
 */
export function averageMonthlyExpenses(flows: readonly MonthFlow[], today: IsoDate): Cents | null {
  const current = today.slice(0, 7);
  const full = flows.filter((flow) => flow.month < current);
  const counted = full.length > 0 ? full : flows;
  if (counted.length === 0) return null;
  return Math.trunc(counted.reduce((sum, flow) => sum + flow.expenses, 0) / counted.length);
}

export interface CategoryRow {
  categoryId: string;
  name: string;
  /** Postings to this category and its subcategories: what a parent's line shows (AC-05.2). */
  total: Cents;
  /** Postings to this category itself. */
  own: Cents;
  children: { categoryId: string; name: string; total: Cents }[];
}

/**
 * Spending (or income) by top-level category, each with its subcategories. The rows sum exactly
 * to Expenses(P) or Income(P) (AC-15.1). Rows that come to 0 are left out.
 */
export function categoryReport(ledger: Ledger, period: Period, kind: 'expense' | 'income' = 'expense'): { rows: CategoryRow[]; total: Cents } {
  const totals = ledger.categoryTotals(kind, period);
  const categories = ledger.chart.all().filter((account) => account.category && account.kind === kind);
  const rows: CategoryRow[] = [];
  for (const parent of categories) {
    if (parent.category!.parentId) continue;
    const children = categories
      .filter((child) => child.category!.parentId === parent.id)
      .map((child) => ({ categoryId: child.id, name: child.name, total: totals.get(child.id) ?? 0 }))
      .filter((child) => child.total !== 0)
      .sort((a, b) => b.total - a.total);
    const own = totals.get(parent.id) ?? 0;
    const total = own + children.reduce((sum, child) => sum + child.total, 0);
    if (total !== 0 || own !== 0 || children.length > 0) rows.push({ categoryId: parent.id, name: parent.name, total, own, children });
  }
  rows.sort((a, b) => b.total - a.total);
  return { rows, total: kind === 'expense' ? ledger.expenses(period) : ledger.income(period) };
}

/** A % change, in tenths, by ordinary rounding (only budget utilization truncates, GT-60). A zero base has none: "new" (FR-15). */
export function percentChangeTenths(from: Cents, to: Cents): number | 'new' | null {
  if (from === 0) return to === 0 ? null : 'new';
  const change = BigInt(to - from) * 2000n;
  const base = BigInt(Math.abs(from));
  // Round half away from zero, in exact integers.
  const doubled = change / base;
  return Number((doubled + (doubled >= 0n ? 1n : -1n)) / 2n);
}

export function formatPercentChange(tenths: number | 'new' | null): string {
  if (tenths === 'new') return 'new';
  if (tenths === null) return '0.0 %';
  const sign = tenths > 0 ? '+' : tenths < 0 ? '−' : '';
  const size = Math.abs(tenths);
  return `${sign}${Math.floor(size / 10)}.${size % 10} %`;
}

export interface ComparisonLine {
  key: string;
  name: string;
  /** The category, or empty for the three totals. */
  categoryId: string | null;
  a: Cents;
  b: Cents;
  change: Cents;
  percentTenths: number | 'new' | null;
}

/** Period comparison, A against B, with the change from A to B (FR-15, AC-15.3). */
export function periodComparison(ledger: Ledger, a: Period, b: Period): { totals: ComparisonLine[]; categories: ComparisonLine[] } {
  const line = (key: string, name: string, categoryId: string | null, from: Cents, to: Cents): ComparisonLine => ({ key, name, categoryId, a: from, b: to, change: to - from, percentTenths: percentChangeTenths(from, to) });
  const fromTotals = ledger.categoryTotals('expense', a);
  const toTotals = ledger.categoryTotals('expense', b);
  const categories = ledger.chart
    .all()
    .filter((account) => account.category && account.kind === 'expense' && ((fromTotals.get(account.id) ?? 0) !== 0 || (toTotals.get(account.id) ?? 0) !== 0))
    .map((account) => line(account.id, account.name, account.id, fromTotals.get(account.id) ?? 0, toTotals.get(account.id) ?? 0))
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  return {
    totals: [line('income', 'income', null, ledger.income(a), ledger.income(b)), line('expenses', 'expenses', null, ledger.expenses(a), ledger.expenses(b)), line('netResult', 'netResult', null, ledger.netResult(a), ledger.netResult(b))],
    categories,
  };
}

export interface NetWorthPoint {
  month: string;
  /** The month's last day, or today for the month in progress. */
  asOf: IsoDate;
  assets: Cents;
  liabilities: Cents;
  netWorth: Cents;
  change: Cents;
  netResult: Cents;
  /** Opening balances, adjustments, valuations and conversions (§2.3). */
  otherEffects: Cents;
  /** AC-15.2: Change = Net Result + the other effects. */
  identityHolds: boolean;
}

/** Net worth at each month-end, with the Net Worth Change identity for every month (AC-15.2). */
export function netWorthByMonth(ledger: Ledger, months: readonly string[], today: IsoDate): NetWorthPoint[] {
  return months.map((month) => {
    const { from, to } = monthRange(month);
    const asOf = to > today ? today : to;
    const period = { from, to };
    const identity = ledger.netWorthIdentity(period);
    const netResult = ledger.netResult(period);
    const netWorth = ledger.netWorth(asOf);
    return {
      month,
      asOf,
      assets: ledger.assets(asOf),
      liabilities: ledger.liabilities(asOf),
      netWorth,
      change: netWorth - ledger.netWorth(addDays(from, -1)),
      netResult,
      otherEffects: identity.right - netResult,
      identityHolds: identity.holds,
    };
  });
}
