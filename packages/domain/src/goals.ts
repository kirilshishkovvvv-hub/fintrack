/**
 * Savings goals and virtual allocations (§8). Goals never post and change no ledger figure
 * (LR-08, AC-09.6). All amounts are integer cents.
 */
import { monthOf, monthRange, type IsoDate } from './dates.ts';
import { cents, type Cents } from './money.ts';

export interface Allocation {
  goalId: string;
  accountId: string;
  amount: Cents;
  /** Goal creation order: breaks ties in the largest-remainder share-out (§8.1). */
  goalOrder: number;
}

/** Shortfall(a) = max(0, Alloc(a) − max(0, Bal(a))). */
export function shortfall(balance: Cents, allocated: Cents): Cents {
  return Math.max(0, allocated - Math.max(0, balance));
}

/** Unallocated(a) = max(0, Bal(a)) − Alloc(a). Negative during a shortfall. */
export function unallocated(balance: Cents, allocated: Cents): Cents {
  return Math.max(0, balance) - allocated;
}

const sum = (allocations: readonly Allocation[]) => allocations.reduce((total, allocation) => total + allocation.amount, 0);

/**
 * Backed(a, g) for one account: each allocation in full, or during a shortfall the positive
 * balance shared in proportion by the largest-remainder method, ties going to the earlier goal
 * (§8.1, GT-52). The result sums exactly to the balance (AC-09.7).
 */
export function backedOnAccount(balance: Cents, allocations: readonly Allocation[]): Map<string, Cents> {
  const total = sum(allocations);
  const available = Math.max(0, balance);
  if (total <= available) return new Map(allocations.map((allocation) => [allocation.goalId, allocation.amount]));
  const shares = allocations.map((allocation) => {
    const numerator = BigInt(available) * BigInt(allocation.amount);
    return { allocation, base: Number(numerator / BigInt(total)), remainder: numerator % BigInt(total) };
  });
  let left = available - shares.reduce((running, share) => running + share.base, 0);
  const byRemainder = [...shares].sort((a, b) => (a.remainder === b.remainder ? a.allocation.goalOrder - b.allocation.goalOrder : a.remainder > b.remainder ? -1 : 1));
  const extra = new Set<Allocation>();
  for (const share of byRemainder) {
    if (left === 0) break;
    extra.add(share.allocation);
    left -= 1;
  }
  return new Map(shares.map((share) => [share.allocation.goalId, share.base + (extra.has(share.allocation) ? 1 : 0)]));
}

/** Backed amount per goal across accounts: Σ over a of Backed(a, g). */
export function backedByGoal(allocations: readonly Allocation[], balanceOf: (accountId: string) => Cents): Map<string, Cents> {
  const result = new Map<string, Cents>();
  for (const accountId of new Set(allocations.map((allocation) => allocation.accountId))) {
    const onAccount = allocations.filter((allocation) => allocation.accountId === accountId);
    for (const [goalId, backed] of backedOnAccount(balanceOf(accountId), onAccount)) {
      result.set(goalId, (result.get(goalId) ?? 0) + backed);
    }
  }
  return result;
}

export class AllocationExceedsUnallocated extends Error {
  override name = 'AllocationExceedsUnallocated';
  constructor(readonly available: Cents) {
    super(`Only ${available} cents are unallocated on this account`);
  }
}

/** G-V2: a create or increase must fit in the positive balance, and never happens during a shortfall. */
export function assertCanAllocate(balance: Cents, allocatedNow: Cents, increase: Cents): void {
  if (increase <= 0) throw new RangeError('The allocation increase must be positive');
  if (shortfall(balance, allocatedNow) > 0 || allocatedNow + increase > Math.max(0, balance)) {
    throw new AllocationExceedsUnallocated(Math.max(0, unallocated(balance, allocatedNow)));
  }
}

/**
 * G-T2: what to offer moving along with a transfer that would create a shortfall: the
 * shortfall shared across the account's allocations in proportion, largest remainder first.
 */
export function allocationsToMove(balanceAfter: Cents, allocations: readonly Allocation[]): Map<string, Cents> {
  const backed = backedOnAccount(balanceAfter, allocations);
  return new Map(allocations.map((allocation) => [allocation.goalId, allocation.amount - (backed.get(allocation.goalId) ?? 0)]).filter(([, amount]) => (amount as number) > 0) as [string, Cents][]);
}

export interface GoalProjection {
  remaining: Cents;
  reached: boolean;
  /** n = ceil(R / c): null with no contribution, or nothing left to save. */
  monthsNeeded: number | null;
  /** The end of month (current month + n − 1). */
  estimatedCompletion: IsoDate | null;
  /** ceil to the cent of R / m: null with no target date, or once it has passed. */
  requiredMonthly: Cents | null;
  behindSchedule: boolean;
}

const monthsApart = (from: string, to: string) => {
  const [fromYear, fromMonth] = from.split('-').map(Number) as [number, number];
  const [toYear, toMonth] = to.split('-').map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
};

const plusMonths = (month: string, count: number) => {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, monthNumber - 1 + count, 1)).toISOString().slice(0, 7);
};

const ceilDivide = (a: number, b: number) => Math.ceil(a / b);

/** §8.8: contributions happen at each month-end, starting with the current month. No target, no projection (§8.9). */
export function goalProjection(input: { target: Cents | null; progress: Cents; monthly: Cents | null; targetDate: IsoDate | null; today: IsoDate }): GoalProjection | null {
  if (input.target === null) return null;
  const remaining = Math.max(0, input.target - input.progress);
  const month = monthOf(input.today);
  const monthly = input.monthly ?? 0;
  const monthsNeeded = remaining > 0 && monthly > 0 ? ceilDivide(remaining, monthly) : null;
  const estimatedCompletion = monthsNeeded === null ? null : monthRange(plusMonths(month, monthsNeeded - 1)).to;
  const left = input.targetDate ? monthsApart(month, monthOf(input.targetDate)) + 1 : 0;
  const requiredMonthly = remaining > 0 && left > 0 ? cents(ceilDivide(remaining, left)) : null;
  return {
    remaining,
    reached: remaining === 0,
    monthsNeeded,
    estimatedCompletion,
    requiredMonthly,
    behindSchedule: requiredMonthly !== null && monthly < requiredMonthly,
  };
}
