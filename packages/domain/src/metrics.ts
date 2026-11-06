/**
 * Canonical metrics (§2.3, §5.3). Every figure is derived from posted transactions only
 * (LR-09) and nothing keeps its own running total (LR-16). The running sums below live only as
 * long as one Ledger, built from the transactions it was given, so any figure over any dates
 * takes a lookup instead of a pass over every posting (NFR-03).
 */
import { addDays, monthRange, type IsoDate } from './dates.ts';
import type { Chart, LedgerAccount, SystemCode, Transaction } from './ledger.ts';
import { cents, type Cents } from './money.ts';

export interface Period {
  from: IsoDate;
  to: IsoDate;
}

/** One account's postings by date, with the running sum up to and including each date. */
interface AccountRun {
  dates: IsoDate[];
  running: number[];
  /** The same, leaving out opening balances (Cash Change, §2.3). */
  runningNoOpening: number[];
}

/** The running value at the last date on or before `date`: a binary search. */
function upTo(run: AccountRun, values: number[], date: IsoDate): number {
  let low = 0;
  let high = run.dates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (run.dates[middle]! <= date) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? 0 : values[low - 1]!;
}

export class Ledger {
  private readonly active: Transaction[];
  private readonly runs = new Map<string, AccountRun>();

  constructor(
    readonly chart: Chart,
    transactions: readonly Transaction[],
  ) {
    this.active = transactions.filter((tx) => tx.status === 'posted');
    const entries = new Map<string, { date: IsoDate; amount: number; opening: boolean }[]>();
    for (const tx of this.active) {
      const opening = tx.kind === 'opening_balance';
      for (const p of tx.postings) {
        let list = entries.get(p.ledgerAccountId);
        if (!list) entries.set(p.ledgerAccountId, (list = []));
        list.push({ date: tx.date, amount: p.amount, opening });
      }
    }
    for (const [accountId, list] of entries) {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const run: AccountRun = { dates: [], running: [], runningNoOpening: [] };
      let total = 0;
      let noOpening = 0;
      for (const entry of list) {
        total += entry.amount;
        if (!entry.opening) noOpening += entry.amount;
        if (run.dates.at(-1) === entry.date) {
          run.running[run.running.length - 1] = total;
          run.runningNoOpening[run.runningNoOpening.length - 1] = noOpening;
        } else {
          run.dates.push(entry.date);
          run.running.push(total);
          run.runningNoOpening.push(noOpening);
        }
      }
      this.runs.set(accountId, run);
    }
  }

  /** Σ postings to the account dated on or before `onDate` (raw signed, debit-positive). */
  rawBalance(accountId: string, onDate: IsoDate): Cents {
    const run = this.runs.get(accountId);
    return cents(run ? upTo(run, run.running, onDate) : 0);
  }

  /** The balance as shown to the user: assets as Σ, liabilities as the amount owed (−Σ). */
  balance(accountId: string, onDate: IsoDate): Cents {
    const raw = this.rawBalance(accountId, onDate);
    return this.chart.get(accountId).kind === 'liability' ? 0 - raw : raw;
  }

  /**
   * The cleared balance for a reconciliation (FR-18): the account's postings in the given
   * transactions only, shown the way `balance` shows it. Voided and trashed ones never count.
   */
  clearedBalance(accountId: string, transactionIds: ReadonlySet<string>): Cents {
    let raw = 0;
    for (const tx of this.active) {
      if (!transactionIds.has(tx.id)) continue;
      for (const p of tx.postings) if (p.ledgerAccountId === accountId) raw += p.amount;
    }
    return this.chart.get(accountId).kind === 'liability' ? cents(0 - raw) : cents(raw);
  }

  /** The sum of the postings to a category and its subcategories in a month, as shown to the user. */
  categoryMonthTotal(categoryId: string, month: string): Cents {
    const raw = this.budgetSpent(categoryId, month);
    return this.chart.get(categoryId).kind === 'income' ? 0 - raw : raw;
  }

  cashBalance(onDate: IsoDate): Cents {
    return this.sumUpTo((account) => this.isCash(account), onDate);
  }

  assets(onDate: IsoDate): Cents {
    return this.sumUpTo((account) => account.kind === 'asset', onDate);
  }

  liabilities(onDate: IsoDate): Cents {
    return 0 - this.sumUpTo((account) => account.kind === 'liability', onDate);
  }

  netWorth(onDate: IsoDate): Cents {
    return this.assets(onDate) - this.liabilities(onDate);
  }

  income(period: Period): Cents {
    return 0 - this.sumIn((account) => account.kind === 'income', period);
  }

  expenses(period: Period): Cents {
    return this.sumIn((account) => account.kind === 'expense', period);
  }

  netResult(period: Period): Cents {
    return this.income(period) - this.expenses(period);
  }

  /** Change in Cash-class balances over the period, excluding opening balances (§2.3). */
  cashChange(period: Period): Cents {
    return this.sumIn((account) => this.isCash(account), period, true);
  }

  /** The effect of a system equity account on net worth over the period (−Σ postings). */
  equityEffect(code: Exclude<SystemCode, 'TIT'>, period: Period): Cents {
    const id = this.systemId(code);
    if (!id) return 0;
    return 0 - this.accountIn(id, period);
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
    const period = monthRange(month);
    let total = 0;
    for (const id of this.chart.categorySubtree(categoryId)) total += this.accountIn(id, period);
    return cents(total);
  }

  /** Spending per expense category in the period (for the category report, AC-15.1). */
  expensesByCategory(period: Period): Map<string, Cents> {
    return this.categoryTotals('expense', period);
  }

  /** Per category, as shown to the user: expenses as Σ, income as −Σ. A category with nothing in the period isn't listed. */
  categoryTotals(kind: 'expense' | 'income', period: Period): Map<string, Cents> {
    const result = new Map<string, Cents>();
    for (const account of this.chart.all()) {
      if (account.kind !== kind) continue;
      const total = this.accountIn(account.id, period);
      if (total !== 0) result.set(account.id, kind === 'income' ? 0 - total : total);
    }
    return result;
  }

  private accountIn(accountId: string, period: Period, noOpening = false): number {
    const run = this.runs.get(accountId);
    if (!run) return 0;
    const values = noOpening ? run.runningNoOpening : run.running;
    return upTo(run, values, period.to) - upTo(run, values, addDays(period.from, -1));
  }

  private sumIn(match: (account: LedgerAccount) => boolean, period: Period, noOpening = false): Cents {
    let total = 0;
    for (const account of this.chart.all()) if (match(account)) total += this.accountIn(account.id, period, noOpening);
    return cents(total);
  }

  private sumUpTo(match: (account: LedgerAccount) => boolean, onDate: IsoDate): Cents {
    let total = 0;
    for (const account of this.chart.all()) {
      if (!match(account)) continue;
      const run = this.runs.get(account.id);
      if (run) total += upTo(run, run.running, onDate);
    }
    return cents(total);
  }

  private isCash(account: LedgerAccount): boolean {
    return account.account?.class === 'cash' || account.systemCode === 'TIT';
  }

  private systemId(code: SystemCode): string | undefined {
    return this.chart.all().find((account) => account.systemCode === code)?.id;
  }
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
