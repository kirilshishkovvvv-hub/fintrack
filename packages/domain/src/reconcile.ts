/**
 * Reconciliation and quick balance updates (FR-18, E-36, E-37, E-43). The server computes
 * every difference; the user only states what the statement or the wallet says.
 */
import type { IsoDate } from './dates.ts';
import type { Ledger } from './metrics.ts';
import type { Cents } from './money.ts';

export interface ReconciliationFigures {
  /** The account's postings in the cleared transactions, as the user sees the balance. */
  cleared: Cents;
  statement: Cents;
  /** cleared − statement. Zero means the reconciliation can be finished as it is (GT-42: −10.00). */
  difference: Cents;
  /** The balance adjustment that closes the difference: −difference (AC-18.1: −8.00). */
  adjustment: Cents;
}

export function reconcile(
  ledger: Ledger,
  input: { accountId: string; statementBalance: Cents; cleared: ReadonlySet<string> },
): ReconciliationFigures {
  const cleared = ledger.clearedBalance(input.accountId, input.cleared);
  const difference = cleared - input.statementBalance;
  return { cleared, statement: input.statementBalance, difference, adjustment: difference === 0 ? 0 : -difference };
}

/**
 * The change a quick balance update needs (FR-18): the actual value minus the ledger's balance
 * on that date. Zero means nothing to post. For a cash account it becomes an adjustment (E-36 or
 * E-37); for an investment or other asset, a valuation (E-43).
 */
export function balanceUpdateDelta(ledger: Ledger, input: { accountId: string; date: IsoDate; actual: Cents }): Cents {
  return input.actual - ledger.balance(input.accountId, input.date);
}
