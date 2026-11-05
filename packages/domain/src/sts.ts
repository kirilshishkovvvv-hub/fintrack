/**
 * Safe to Spend (§7.4, F3): STS = ELF − UCO − PR − UGA, with the window running to the next
 * payday. The result carries every item behind every term, so each term can be traced (P8).
 * Expected income is never added (P6); it only sets the window.
 */
import { addDays, type IsoDate } from './dates.ts';
import { backedByGoal, shortfall, type Allocation } from './goals.ts';
import type { LedgerAccount } from './ledger.ts';
import type { Ledger } from './metrics.ts';
import { cents, type Cents } from './money.ts';
import type { PlannedItem } from './planning.ts';

/** A payday further ahead than this doesn't set the window (S-2). */
const PAYDAY_CAP_DAYS = 45;
const FALLBACK_DAYS = 30;

export interface SafeToSpendInput {
  ledger: Ledger;
  today: IsoDate;
  protectedReserve?: Cents;
  /** Only Planned occurrences: completed, skipped and cancelled ones never reach this function. */
  planned?: readonly PlannedItem[];
  allocations?: readonly Allocation[];
  /** S-5: do planned transfers to savings count as commitments? On by default. */
  countSavingsTransfers?: boolean;
}

export interface SafeToSpendWindow {
  kind: 'payday' | 'fallback';
  from: IsoDate;
  /** The last day counted. */
  to: IsoDate;
  /** The payday that ends the window, in the payday case. */
  payday: IsoDate | null;
  /** Days the amount is meant to last: H − today (at least 1), or 31 in the fallback (ER-1). */
  days: number;
}

export type UcoItem =
  | { type: 'planned' | 'overdue'; item: PlannedItem; amount: Cents; coveredByGoal: Cents }
  | { type: 'card_expense'; item: PlannedItem; amount: Cents; coveredByGoal: Cents }
  | { type: 'card_reserve'; accountId: string; amount: Cents };

export type UgaItem =
  | { type: 'allocation'; accountId: string; goalId: string; amount: Cents }
  | { type: 'shortfall'; accountId: string; amount: Cents };

export interface SafeToSpendBreakdown {
  /** Eligible liquid funds: balances of spendable accounts, negatives included. */
  elf: Cents;
  elfItems: { accountId: string; amount: Cents }[];
  uco: Cents;
  ucoItems: UcoItem[];
  /** Component (3) of UCO on its own: Σ max(0, owed) over cards with the reserve on. */
  cardReserve: Cents;
  protectedReserve: Cents;
  uga: Cents;
  ugaItems: UgaItem[];
  value: Cents;
  window: SafeToSpendWindow;
  /** STS ÷ days, rounded down to the cent; null when there's nothing to share out (ER-1). */
  perDay: Cents | null;
  /** Information only, never subtracted: items due on payday, outside the window. */
  dueOnPayday: PlannedItem[];
  /** Information only: payday income that hasn't arrived (§7.7). */
  latePayday: PlannedItem[];
  /** Information only: income expected inside the window, never added (P6). */
  expectedIncome: PlannedItem[];
}

const isSpendable = (account: LedgerAccount | undefined) => {
  const info = account?.account;
  return Boolean(info && !account!.archived && info.class === 'cash' && info.spendable);
};

const isReservedCard = (account: LedgerAccount | undefined) => {
  const info = account?.account;
  return Boolean(info && !account!.archived && info.type === 'card' && info.cardReserve);
};

function windowFor(today: IsoDate, planned: readonly PlannedItem[]): SafeToSpendWindow {
  const cap = addDays(today, PAYDAY_CAP_DAYS);
  const payday = planned
    .filter((item) => item.isPayday && item.dueDate >= today && item.dueDate <= cap)
    .map((item) => item.dueDate)
    .sort()[0];
  if (!payday) return { kind: 'fallback', from: today, to: addDays(today, FALLBACK_DAYS), payday: null, days: FALLBACK_DAYS + 1 };
  // Option (c): payday itself is out, except on the day while the salary is unmatched (S-4).
  const to = payday === today ? today : addDays(payday, -1);
  const days = Math.max(1, Math.round((Date.parse(`${payday}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
  return { kind: 'payday', from: today, to, payday, days };
}

/** Which UCO component a planned item falls under, if any (§7.4). */
function outflowType(item: PlannedItem, ledger: Ledger, countSavingsTransfers: boolean): 'spendable' | 'reserved_card' | null {
  if (item.kind === 'income' || !item.fromAccountId) return null;
  const from = ledger.chart.find(item.fromAccountId);
  if (isReservedCard(from)) return item.kind === 'expense' ? 'reserved_card' : null;
  if (!isSpendable(from)) return null;
  if (item.kind === 'expense') return 'spendable';
  const to = item.toAccountId ? ledger.chart.find(item.toAccountId) : undefined;
  if (isSpendable(to) || isReservedCard(to)) return null; // R6, R1
  if (to?.account?.class === 'cash') return countSavingsTransfers ? 'spendable' : null; // S-5
  return 'spendable';
}

export function safeToSpend(input: SafeToSpendInput): SafeToSpendBreakdown {
  const { ledger, today } = input;
  const protectedReserve = input.protectedReserve ?? 0;
  if (protectedReserve < 0) throw new RangeError('The protected reserve cannot be negative');
  const planned = input.planned ?? [];
  const allocations = input.allocations ?? [];
  const countSavingsTransfers = input.countSavingsTransfers ?? true;
  const window = windowFor(today, planned);

  const elfItems: SafeToSpendBreakdown['elfItems'] = [];
  const reserveItems: UcoItem[] = [];
  for (const account of ledger.chart.all()) {
    if (isSpendable(account)) elfItems.push({ accountId: account.id, amount: ledger.balance(account.id, today) });
    if (isReservedCard(account)) {
      const owed = Math.max(0, ledger.balance(account.id, today));
      if (owed > 0) reserveItems.push({ type: 'card_reserve', accountId: account.id, amount: owed });
    }
  }
  const elf = elfItems.reduce((total, item) => total + item.amount, 0);

  // R5: a goal's backed money covers its linked payments, earliest first, and each cent only once.
  const coverage = backedByGoal(allocations, (accountId) => ledger.balance(accountId, today));
  const covered = new Map<string, Cents>();
  const counted = planned.filter((item) => outflowType(item, ledger, countSavingsTransfers) !== null);
  const byDueDate = [...counted].sort((a, b) => (a.dueDate === b.dueDate ? (a.originalDate < b.originalDate ? -1 : 1) : a.dueDate < b.dueDate ? -1 : 1));
  for (const item of byDueDate) {
    if (!item.goalId) continue;
    const left = coverage.get(item.goalId) ?? 0;
    const used = Math.min(left, item.amount);
    coverage.set(item.goalId, left - used);
    covered.set(item.id, used);
  }

  const ucoItems: UcoItem[] = [];
  const dueOnPayday: PlannedItem[] = [];
  for (const item of byDueDate) {
    const coveredByGoal = covered.get(item.id) ?? 0;
    const amount = item.amount - coveredByGoal;
    const overdue = item.dueDate < today;
    const inWindow = item.dueDate >= window.from && item.dueDate <= window.to;
    if (overdue || inWindow) {
      const isCard = outflowType(item, ledger, countSavingsTransfers) === 'reserved_card';
      ucoItems.push({ type: isCard ? 'card_expense' : overdue ? 'overdue' : 'planned', item, amount, coveredByGoal });
    } else if (item.dueDate === window.payday) {
      dueOnPayday.push(item);
    }
  }
  ucoItems.push(...reserveItems);
  const uco = ucoItems.reduce((total, item) => total + item.amount, 0);
  const cardReserve = reserveItems.reduce((total, item) => total + item.amount, 0);

  // AM-1: allocations on spendable money count in full; on other accounts, only what has left them.
  const ugaItems: UgaItem[] = [];
  for (const accountId of new Set(allocations.map((allocation) => allocation.accountId))) {
    const onAccount = allocations.filter((allocation) => allocation.accountId === accountId);
    if (isSpendable(ledger.chart.find(accountId))) {
      for (const allocation of onAccount) ugaItems.push({ type: 'allocation', accountId, goalId: allocation.goalId, amount: allocation.amount });
    } else {
      const allocated = onAccount.reduce((total, allocation) => total + allocation.amount, 0);
      const missing = shortfall(ledger.balance(accountId, today), allocated);
      if (missing > 0) ugaItems.push({ type: 'shortfall', accountId, amount: missing });
    }
  }
  const uga = ugaItems.reduce((total, item) => total + item.amount, 0);

  const value = elf - uco - protectedReserve - uga;
  return {
    elf: cents(elf),
    elfItems,
    uco: cents(uco),
    ucoItems,
    cardReserve: cents(cardReserve),
    protectedReserve,
    uga: cents(uga),
    ugaItems,
    value: cents(value),
    window,
    perDay: value > 0 ? cents(Math.floor(value / window.days)) : null,
    dueOnPayday,
    latePayday: planned.filter((item) => item.isPayday && item.dueDate < today),
    expectedIncome: planned.filter((item) => item.kind === 'income' && item.dueDate >= window.from && item.dueDate <= window.to),
  };
}
