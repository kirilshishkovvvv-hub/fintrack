/**
 * Checks one scenario Check against a Ledger. Shared by every harness, so the
 * in-memory and database runs assert exactly the same Stage 1 numbers.
 */
import { expect } from 'vitest';
import {
  formatAmount,
  formatUtilization,
  parseAmount,
  safeToSpend,
  utilizationTenths,
  type Ledger,
} from '@fintrack/domain';
import type { Check } from './scenario.ts';

const money = (value: number) => formatAmount(value);
const expected = (amount: string) => formatAmount(parseAmount(amount));

/** `idOf` maps a scenario name ("Current", "Food") to the ledger account id used by the harness. */
export function verifyCheck(ledger: Ledger, check: Check, idOf: (name: string) => string = (name) => name): void {
  const at = check.at;

  for (const [name, amount] of Object.entries(check.balances ?? {})) {
    expect(money(ledger.balance(idOf(name), at)), `balance of ${name} on ${at}`).toBe(expected(amount));
  }
  if (check.assets) expect(money(ledger.assets(at)), `assets on ${at}`).toBe(expected(check.assets));
  if (check.liabilities) expect(money(ledger.liabilities(at)), `liabilities on ${at}`).toBe(expected(check.liabilities));
  if (check.netWorth) expect(money(ledger.netWorth(at)), `net worth on ${at}`).toBe(expected(check.netWorth));
  if (check.safeToSpend) {
    expect(money(safeToSpend({ ledger, today: at }).value), `Safe to Spend on ${at}`).toBe(expected(check.safeToSpend));
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
  }
}
