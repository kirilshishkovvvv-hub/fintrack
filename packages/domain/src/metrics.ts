/**
 * Canonical metrics (§2.3, §5.3). Every figure is derived from posted transactions only
 * (LR-09) and nothing keeps its own running total (LR-16).
 */
import { addDays, monthRange, type IsoDate } from './dates.ts';
import type { Chart, LedgerAccount, SystemCode, Transaction } from './ledger.ts';
import { cents, type Cents } from './money.ts';

export interface Period {
  from: IsoDate;
  to: IsoDate;
}

export class Ledger {
  private readonly active: Transaction[];

  constructor(
    readonly chart: Chart,
    transactions: readonly Transaction[],
  ) {
    this.active = transactions.filter((tx) => tx.status === 'posted');
  }

  /** Σ postings to the account dated on or before `onDate` (raw signed, debit-positive). */
  rawBalance(accountId: string, onDate: IsoDate): Cents {
    return this.sum((tx, p) => p.ledgerAccountId === accountId && tx.date <= onDate);
  }

  /** The balance as shown to the user: assets as Σ, liabilities as the amount owed (−Σ). */
  balance(accountId: string, onDate: IsoDate): Cents {
    const raw = this.rawBalance(accountId, onDate);
    return this.chart.get(accountId).kind === 'liability' ? -raw : raw;
  }

  /**
   * The cleared balance for a reconciliation (FR-18): the account's postings in the given
   * transactions only, shown the way `balance` shows it. Voided and trashed ones never count.
   */
  clearedBalance(accountId: string, transactionIds: ReadonlySet<string>): Cents {
    const raw = this.sum((tx, p) => p.ledgerAccountId === accountId && transactionIds.has(tx.id));
    return this.chart.get(accountId).kind === 'liability' ? -raw : raw;
  }

  /** The sum of the postings to a category and its subcategories in a month, as shown to the user. */
  categoryMonthTotal(categoryId: string, month: string): Cents {
    const raw = this.budgetSpent(categoryId, month);
    return this.chart.get(categoryId).kind === 'income' ? -raw : raw;
  }

  cashBalance(onDate: IsoDate): Cents {
    return this.sum((tx, p) => tx.date <= onDate && this.isCash(this.chart.get(p.ledgerAccountId)));
  }

  assets(onDate: IsoDate): Cents {
    return this.sum((tx, p) => tx.date <= onDate && this.chart.get(p.ledgerAccountId).kind === 'asset');
  }

  liabilities(onDate: IsoDate): Cents {
    return -this.sum((tx, p) => tx.date <= onDate && this.chart.get(p.ledgerAccountId).kind === 'liability');
  }

  netWorth(onDate: IsoDate): Cents {
    return this.assets(onDate) - this.liabilities(onDate);
  }

  income(period: Period): Cents {
    return -this.sum((tx, p) => inPeriod(tx, period) && this.chart.get(p.ledgerAccountId).kind === 'income');
  }

  expenses(period: Period): Cents {
    return this.sum((tx, p) => inPeriod(tx, period) && this.chart.get(p.ledgerAccountId).kind === 'expense');
  }

  netResult(period: Period): Cents {
    return this.income(period) - this.expenses(period);
  }

  /** Change in Cash-class balances over the period, excluding opening balances (§2.3). */
  cashChange(period: Period): Cents {
    return this.sum(
      (tx, p) =>
        inPeriod(tx, period) && tx.kind !== 'opening_balance' && this.isCash(this.chart.get(p.ledgerAccountId)),
    );
  }

  /** The effect of a system equity account on net worth over the period (−Σ postings). */
  equityEffect(code: Exclude<SystemCode, 'TIT'>, period: Period): Cents {
    const id = this.systemId(code);
    if (!id) return 0;
    return -this.sum((tx, p) => inPeriod(tx, period) && p.ledgerAccountId === id);
  }

  /**
   * Net Worth Change identity (§2.3, AP-14):
   * NW(to) − NW(from − 1) = Net Result + OBE + ADJ + VAL + CNV effects.
   */
  netWorthIdentity(period: Period): { left: Cents; right: Cents; holds: boolean } {
    const left = this.netWorth(period.to) - this.netWorth(addDays(period.from, -1));
    const right =
      this.netResult(period) +
      this.equityEffect('OBE', period) +
      this.equityEffect('ADJ', period) +
      this.equityEffect('VAL', period) +
      this.equityEffect('CNV', period);
    return { left, right, holds: left === right };
  }

  /** Budget Spent(c, M): expense postings in the category subtree, net of refunds (§2.3). */
  budgetSpent(categoryId: string, month: string): Cents {
    const subtree = this.chart.categorySubtree(categoryId);
    const period = monthRange(month);
    return this.sum((tx, p) => inPeriod(tx, period) && subtree.has(p.ledgerAccountId));
  }

  /** Spending per expense category in the period (for the category report, AC-15.1). */
  expensesByCategory(period: Period): Map<string, Cents> {
    const result = new Map<string, Cents>();
    for (const tx of this.active) {
      if (!inPeriod(tx, period)) continue;
      for (const p of tx.postings) {
        if (this.chart.get(p.ledgerAccountId).kind !== 'expense') continue;
        result.set(p.ledgerAccountId, (result.get(p.ledgerAccountId) ?? 0) + p.amount);
      }
    }
    return result;
  }

  private isCash(account: LedgerAccount): boolean {
    return account.account?.class === 'cash' || account.systemCode === 'TIT';
  }

  private systemId(code: SystemCode): string | undefined {
    return this.chart.all().find((account) => account.systemCode === code)?.id;
  }

  private sum(match: (tx: Transaction, posting: Transaction['postings'][number]) => boolean): Cents {
    let total = 0;
    for (const tx of this.active) {
      for (const p of tx.postings) {
        if (match(tx, p)) total += p.amount;
      }
    }
    return cents(total);
  }
}

function inPeriod(tx: Transaction, period: Period): boolean {
  return tx.date >= period.from && tx.date <= period.to;
}

/**
 * Budget utilization for display, truncated (never rounded up) to one decimal place (AM-3).
 * Returns tenths of a percent: 666 means "66.6 %". A net refund shows as 0.
 * A zero limit with any spending is "over" (FR-07 edge case).
 */
export function utilizationTenths(spent: Cents, limit: Cents): number | 'over' {
  if (spent <= 0) return 0;
  if (limit === 0) return 'over';
  return Number((BigInt(spent) * 1000n) / BigInt(limit));
}

export function formatUtilization(tenths: number | 'over'): string {
  if (tenths === 'over') return 'over';
  return `${Math.floor(tenths / 10)}.${tenths % 10} %`;
}

/** Threshold check in exact integers: Spent × 100 ≥ Limit × threshold (BR-07.7). */
export function thresholdReached(spent: Cents, limit: Cents, thresholdPercent: number): boolean {
  return BigInt(spent) * 100n >= BigInt(limit) * BigInt(thresholdPercent);
}
