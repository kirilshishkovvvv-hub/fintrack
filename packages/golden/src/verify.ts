/**
 * Checks one scenario Check against a Ledger. Shared by every harness, so the
 * in-memory and database runs assert exactly the same Stage 1 numbers.
 */
import { expect } from 'vitest';
import {
  formatAmount,
  backedByGoal,
  formatUtilization,
  parseAmount,
  safeToSpend,
  scheduledInMonth,
  thresholdReached,
  utilizationTenths,
  type Ledger,
} from '@fintrack/domain';
import type { PlanningState } from './memory-runner.ts';
import type { Check } from './scenario.ts';

const money = (value: number) => formatAmount(value);
const expected = (amount: string) => formatAmount(parseAmount(amount));

/** `idOf` maps a scenario name ("Current", "Food") to the ledger account id used by the harness. */
export function verifyCheck(ledger: Ledger, check: Check, idOf: (name: string) => string = (name) => name, planningAt?: (at: string) => PlanningState): void {
  const at = check.at;
  const planning = planningAt?.(at);

  for (const [name, amount] of Object.entries(check.balances ?? {})) {
    expect(money(ledger.balance(idOf(name), at)), `balance of ${name} on ${at}`).toBe(expected(amount));
  }
  if (check.assets) expect(money(ledger.assets(at)), `assets on ${at}`).toBe(expected(check.assets));
  if (check.liabilities) expect(money(ledger.liabilities(at)), `liabilities on ${at}`).toBe(expected(check.liabilities));
  if (check.netWorth) expect(money(ledger.netWorth(at)), `net worth on ${at}`).toBe(expected(check.netWorth));
  const sts = safeToSpend({
    ledger,
    today: at,
    ...(planning
      ? { planned: planning.planned, allocations: planning.allocations, protectedReserve: planning.protectedReserve, countSavingsTransfers: planning.countSavingsTransfers }
      : {}),
  });
  if (check.safeToSpend) expect(money(sts.value), `Safe to Spend on ${at}`).toBe(expected(check.safeToSpend));
  if (check.uco) expect(money(sts.uco), `UCO on ${at}`).toBe(expected(check.uco));
  if (check.uga) expect(money(sts.uga), `UGA on ${at}`).toBe(expected(check.uga));
  if (check.windowTo) expect(sts.window.to, `window on ${at}`).toBe(check.windowTo);
  if (check.perDay) expect(money(sts.perDay ?? 0), `per day on ${at}`).toBe(expected(check.perDay));
  if (check.dueOnPayday) expect(sts.dueOnPayday.map((item) => item.name), `due on payday, ${at}`).toEqual(check.dueOnPayday);
  if (check.latePayday) expect(sts.latePayday.map((item) => item.name), `late payday, ${at}`).toEqual(check.latePayday);
  if (check.expectedIncome) expect(sts.expectedIncome.map((item) => item.name), `expected income, ${at}`).toEqual(check.expectedIncome);
  // P8: every term traces to its items.
  expect(sts.ucoItems.reduce((total, item) => total + item.amount, 0), 'UCO items sum to UCO').toBe(sts.uco);
  expect(sts.ugaItems.reduce((total, item) => total + item.amount, 0), 'UGA items sum to UGA').toBe(sts.uga);
  expect(sts.elfItems.reduce((total, item) => total + item.amount, 0), 'ELF items sum to ELF').toBe(sts.elf);
  expect(sts.value, 'the formula').toBe(sts.elf - sts.uco - sts.protectedReserve - sts.uga);

  if (check.backed) {
    const backed = backedByGoal(planning?.allocations ?? [], (accountId) => ledger.balance(accountId, at));
    for (const [goal, amount] of Object.entries(check.backed)) expect(money(backed.get(goal) ?? 0), `${goal} backed on ${at}`).toBe(expected(amount));
  }
  for (const [goal, amount] of Object.entries(check.progress ?? {})) {
    const total = (planning?.dedicated.get(goal) ?? []).reduce((sum, name) => sum + Math.max(0, ledger.balance(idOf(name), at)), 0);
    expect(money(total), `${goal} progress on ${at}`).toBe(expected(amount));
  }
  for (const scheduled of check.scheduled ?? []) {
    const categories = new Set(ledger.chart.categorySubtree(idOf(scheduled.category)));
    expect(money(scheduledInMonth(planning?.planned ?? [], categories, scheduled.month, at)), `${scheduled.category} scheduled`).toBe(expected(scheduled.amount));
  }

  for (const flow of check.flows ?? []) {
    const period = { from: flow.from, to: flow.to };
    const label = `${flow.from}..${flow.to}`;
    if (flow.income) expect(money(ledger.income(period)), `income ${label}`).toBe(expected(flow.income));
    if (flow.expenses) expect(money(ledger.expenses(period)), `expenses ${label}`).toBe(expected(flow.expenses));
    if (flow.netResult) expect(money(ledger.netResult(period)), `net result ${label}`).toBe(expected(flow.netResult));
    if (flow.cashChange) expect(money(ledger.cashChange(period)), `cash change ${label}`).toBe(expected(flow.cashChange));
    if (flow.byCategory) {
      const byCategory = ledger.expensesByCategory(period);
      for (const [category, amount] of Object.entries(flow.byCategory)) {
        expect(money(byCategory.get(idOf(category)) ?? 0), `${category} ${label}`).toBe(expected(amount));
      }
      const total = [...byCategory.values()].reduce((sum, value) => sum + value, 0);
      expect(total, `category report total equals Expenses ${label} (AC-15.1)`).toBe(ledger.expenses(period));
    }
    if (flow.netWorthIdentity) {
      const identity = ledger.netWorthIdentity(period);
      expect(identity.holds, `Net Worth identity ${label}: ${identity.left} vs ${identity.right}`).toBe(true);
    }
  }

  for (const budget of check.budgets ?? []) {
    const spent = ledger.budgetSpent(idOf(budget.category), budget.month);
    expect(money(spent), `${budget.category} spent in ${budget.month}`).toBe(expected(budget.spent));
    expect(formatUtilization(utilizationTenths(spent, parseAmount(budget.limit))), `${budget.category} utilization`).toBe(
      budget.display,
    );
    if (budget.crossed) {
      const limit = parseAmount(budget.limit);
      expect([80, 100].filter((threshold) => thresholdReached(spent, limit, threshold)), `${budget.category} thresholds`).toEqual(budget.crossed);
    }
  }
}
