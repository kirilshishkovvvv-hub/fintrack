/**
 * Recurring rules and planned occurrences (FR-08, §9.5). Nothing here posts: planned items
 * never touch a balance or a metric (LR-07, BR-08.9).
 */
import { addDays, monthRange, type IsoDate } from './dates.ts';
import type { Cents } from './money.ts';

export type Frequency = 'weekly' | 'every_n_weeks' | 'monthly_day' | 'monthly_last' | 'every_n_months' | 'yearly';
export type NonWorkingDay = 'on_date' | 'previous' | 'next';
export type PlannedKind = 'expense' | 'income' | 'transfer' | 'debt_payment';
export type AmountType = 'fixed' | 'estimated';

export interface Schedule {
  frequency: Frequency;
  /** N in "every N weeks" and "every N months"; 1 otherwise. */
  interval?: number;
  /** Day of the month for monthly rules; defaults to the start date's day. */
  anchorDay?: number;
  startDate: IsoDate;
  endDate?: IsoDate | null;
  maxCount?: number | null;
  nonWorkingDay?: NonWorkingDay;
}

export interface ScheduledDate {
  /** The key of the occurrence: it never moves (BR-08.2). */
  originalDate: IsoDate;
  /** The original date after the non-working-day setting (SC-1). */
  dueDate: IsoDate;
}

/** One unmatched planned item, as Safe to Spend, budgets and matching see it. */
export interface PlannedItem {
  id: string;
  name: string;
  kind: PlannedKind;
  originalDate: IsoDate;
  dueDate: IsoDate;
  amount: Cents;
  /** Where the money leaves from: empty for income. */
  fromAccountId: string | null;
  /** Where it arrives: the account for income and transfers, the liability for a debt payment. */
  toAccountId: string | null;
  /** Category lines, positive amounts, for the budget's Scheduled figure (BR-07.5). */
  lines?: readonly { categoryId: string; amount: Cents }[];
  isPayday?: boolean;
  /** R5: the goal whose money covers this payment. */
  goalId?: string | null;
  amountType?: AmountType;
  /** M-2's W, from the rule's frequency. */
  windowDays?: number;
  /** Payday rules: the normalized payer, and the optional expected range (SC-2). */
  payer?: string | null;
  expectedMin?: Cents | null;
  expectedMax?: Cents | null;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Day 29, 30 or 31 falls on the last day of a shorter month (BR-08.7). */
function clampedDate(year: number, monthIndex: number, day: number): IsoDate {
  const normalized = new Date(Date.UTC(year, monthIndex, 1));
  const last = daysInMonth(normalized.getUTCFullYear(), normalized.getUTCMonth());
  return new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}

/** Weekends only in the MVP; public holidays come later (OD-09). */
export function shiftForNonWorkingDay(date: IsoDate, setting: NonWorkingDay = 'on_date'): IsoDate {
  if (setting === 'on_date') return date;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday !== 0 && weekday !== 6) return date;
  if (setting === 'previous') return addDays(date, weekday === 6 ? -1 : -2);
  return addDays(date, weekday === 6 ? 2 : 1);
}

/** Every occurrence of a schedule up to and including `until`, by original date. */
export function scheduledDates(schedule: Schedule, until: IsoDate): ScheduledDate[] {
  const interval = schedule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) throw new RangeError('The interval must be a whole number of at least 1');
  const [startYear, startMonth, startDay] = schedule.startDate.split('-').map(Number) as [number, number, number];
  const anchor = schedule.anchorDay ?? startDay;
  const last = schedule.endDate && schedule.endDate < until ? schedule.endDate : until;
  const result: ScheduledDate[] = [];
  const push = (originalDate: IsoDate) => result.push({ originalDate, dueDate: shiftForNonWorkingDay(originalDate, schedule.nonWorkingDay) });
  const full = () => schedule.maxCount != null && result.length >= schedule.maxCount;

  if (schedule.frequency === 'weekly' || schedule.frequency === 'every_n_weeks') {
    const step = 7 * (schedule.frequency === 'weekly' ? 1 : interval);
    for (let date = schedule.startDate; date <= last && !full(); date = addDays(date, step)) push(date);
    return result;
  }

  const monthStep = schedule.frequency === 'yearly' ? 12 : schedule.frequency === 'every_n_months' ? interval : 1;
  for (let index = 0; !full(); index += 1) {
    const monthIndex = startMonth - 1 + index * monthStep;
    const date =
      schedule.frequency === 'monthly_last'
        ? clampedDate(startYear, monthIndex, 31)
        : clampedDate(startYear, monthIndex, schedule.frequency === 'yearly' ? startDay : anchor);
    if (date > last) break;
    if (date >= schedule.startDate) push(date);
  }
  return result;
}

/** The rolling 13-month window (BR-08.2), measured from `today`. */
export function generationHorizon(today: IsoDate): IsoDate {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  return clampedDate(year, month - 1 + 13, day);
}

/** M-2: W = min(5, floor((P − 1) / 2)), where P is the shortest gap between occurrences. A one-off uses the most generous W. */
export function matchingWindowDays(schedule?: Pick<Schedule, 'frequency' | 'interval'> | null): number {
  if (!schedule) return 5;
  const interval = schedule.interval ?? 1;
  const period = {
    weekly: 7,
    every_n_weeks: 7 * interval,
    monthly_day: 28,
    monthly_last: 28,
    every_n_months: 28 * interval,
    yearly: 365,
  }[schedule.frequency];
  return Math.min(5, Math.floor((period - 1) / 2));
}

/** What the rule says should happen to each stored occurrence when it's edited (BR-08.6). */
export interface StoredOccurrence {
  id: string;
  originalDate: IsoDate;
  dueDate: IsoDate;
  status: 'planned' | 'completed' | 'skipped' | 'cancelled';
  isEdited: boolean;
}

export interface Regeneration {
  /** Dates with no occurrence yet. */
  insert: ScheduledDate[];
  /** Future planned, unedited occurrences that take the rule's new values. */
  update: (ScheduledDate & { id: string })[];
  /** Future planned, unedited occurrences the rule no longer produces. */
  cancel: string[];
}

/**
 * Applies a changed schedule from `effectiveFrom` onward. Completed, skipped, cancelled and
 * individually edited occurrences stay as they are, and so does anything before that date.
 */
export function regenerate(schedule: Schedule, stored: readonly StoredOccurrence[], effectiveFrom: IsoDate, until: IsoDate): Regeneration {
  const wanted = new Map(scheduledDates(schedule, until).map((date) => [date.originalDate, date]));
  const known = new Map(stored.map((occurrence) => [occurrence.originalDate, occurrence]));
  const result: Regeneration = { insert: [], update: [], cancel: [] };
  for (const [originalDate, date] of wanted) {
    const existing = known.get(originalDate);
    if (!existing && originalDate >= effectiveFrom) result.insert.push(date);
    else if (existing && existing.status === 'planned' && !existing.isEdited && originalDate >= effectiveFrom) result.update.push({ ...date, id: existing.id });
  }
  for (const occurrence of stored) {
    if (occurrence.status === 'planned' && !occurrence.isEdited && occurrence.originalDate >= effectiveFrom && !wanted.has(occurrence.originalDate)) {
      result.cancel.push(occurrence.id);
    }
  }
  return result;
}

/** An actual movement on one account, offered for matching (M-5). */
export interface MatchCandidate {
  date: IsoDate;
  accountId: string;
  direction: 'in' | 'out';
  amount: Cents;
  payer?: string | null;
}

export interface MatchSuggestion {
  item: PlannedItem;
  daysAway: number;
  /** A payday match whose amount is outside the expected range is still offered, labelled (GT-64). */
  outsideExpectedRange: boolean;
}

const daysBetween = (a: IsoDate, b: IsoDate) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Exact integer comparison: within `percent` of the planned amount. */
const withinPercent = (actual: Cents, planned: Cents, percent: number) => Math.abs(actual - planned) * 100 <= planned * percent;

function sameDirection(item: PlannedItem, candidate: MatchCandidate): boolean {
  if (candidate.direction === 'out') return item.fromAccountId === candidate.accountId;
  return item.toAccountId === candidate.accountId && (item.kind === 'income' || item.kind === 'transfer');
}

/** The planned items an actual movement might be, nearest first (M-1 to M-4, M-6). Never applied without the user (M-5). */
export function suggestMatches(candidate: MatchCandidate, items: readonly PlannedItem[]): MatchSuggestion[] {
  const suggestions: MatchSuggestion[] = [];
  for (const item of items) {
    if (!sameDirection(item, candidate)) continue;
    const daysAway = daysBetween(candidate.date, item.dueDate);
    if (daysAway > (item.windowDays ?? 5)) continue;
    if (item.isPayday) {
      if (!item.payer || !candidate.payer || item.payer !== candidate.payer) continue;
    } else if (!withinPercent(candidate.amount, item.amount, item.amountType === 'estimated' ? 30 : 10)) {
      continue;
    }
    const outsideExpectedRange = Boolean(item.isPayday) && ((item.expectedMin != null && candidate.amount < item.expectedMin) || (item.expectedMax != null && candidate.amount > item.expectedMax));
    suggestions.push({ item, daysAway, outsideExpectedRange });
  }
  return suggestions.sort((a, b) => a.daysAway - b.daysAway || (a.item.originalDate < b.item.originalDate ? -1 : a.item.originalDate > b.item.originalDate ? 1 : 0));
}

/** M-7: an unmatched planned item and an actual movement that look like the same thing. */
export function possibleDoubleCounts(items: readonly PlannedItem[], movements: readonly (MatchCandidate & { transactionId: string })[]): { item: PlannedItem; transactionId: string }[] {
  const found: { item: PlannedItem; transactionId: string }[] = [];
  for (const item of items) {
    if (item.isPayday) continue;
    const movement = movements.find((candidate) => sameDirection(item, candidate) && daysBetween(candidate.date, item.dueDate) <= (item.windowDays ?? 5) && withinPercent(candidate.amount, item.amount, 10));
    if (movement) found.push({ item, transactionId: movement.transactionId });
  }
  return found;
}

/** BR-07.5: unmatched planned items in a category set, due later in the month. */
export function scheduledInMonth(items: readonly PlannedItem[], categoryIds: ReadonlySet<string>, month: string, today: IsoDate): Cents {
  const { to } = monthRange(month);
  let total = 0;
  for (const item of items) {
    if (item.dueDate < today || item.dueDate > to || !item.dueDate.startsWith(month)) continue;
    for (const line of item.lines ?? []) if (categoryIds.has(line.categoryId)) total += line.amount;
  }
  return total;
}
