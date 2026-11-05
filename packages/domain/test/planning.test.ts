/** Schedules, matching, goals and the projection: Stage 1 tests that aren't about one balance sheet (GT-30, 52, 64, 68; §8.8; AC-13.1). */
import { describe, expect, test } from 'vitest';
import {
  allocationsToMove,
  assertCanAllocate,
  AllocationExceedsUnallocated,
  backedOnAccount,
  Chart,
  generationHorizon,
  goalProjection,
  Ledger,
  matchingWindowDays,
  possibleDoubleCounts,
  projection,
  regenerate,
  scheduledDates,
  scheduledInMonth,
  shiftForNonWorkingDay,
  suggestMatches,
  thresholdReached,
  type PlannedItem,
  type StoredOccurrence,
  type Transaction,
} from '../src/index.ts';

const item = (over: Partial<PlannedItem>): PlannedItem => ({
  id: over.id ?? over.dueDate ?? 'x',
  name: 'x',
  kind: 'expense',
  originalDate: over.dueDate ?? '2026-03-25',
  dueDate: '2026-03-25',
  amount: 60000,
  fromAccountId: 'current',
  toAccountId: null,
  ...over,
});

describe('schedules (FR-08)', () => {
  const monthly31 = { frequency: 'monthly_day', anchorDay: 31, startDate: '2026-01-31' } as const;

  test('GT-30: day 31 falls on the last day of shorter months, 13 in the window', () => {
    const horizon = generationHorizon('2026-01-01');
    expect(horizon).toBe('2027-02-01');
    expect(scheduledDates(monthly31, horizon).map((date) => date.originalDate)).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31',
    ]);
    expect(scheduledDates(monthly31, '2028-03-01').map((date) => date.originalDate)).toContain('2028-02-29');
  });

  test('a start after the day of the month begins next month; an end date and a count stop it', () => {
    expect(scheduledDates({ frequency: 'monthly_day', anchorDay: 5, startDate: '2026-03-20' }, '2026-05-31').map((d) => d.originalDate)).toEqual(['2026-04-05', '2026-05-05']);
    expect(scheduledDates({ frequency: 'monthly_day', anchorDay: 5, startDate: '2026-03-01', endDate: '2026-04-30' }, '2026-12-31')).toHaveLength(2);
    expect(scheduledDates({ frequency: 'monthly_day', anchorDay: 5, startDate: '2026-03-01', maxCount: 3 }, '2026-12-31')).toHaveLength(3);
  });

  test('every other frequency', () => {
    expect(scheduledDates({ frequency: 'weekly', startDate: '2026-03-02' }, '2026-03-16').map((d) => d.originalDate)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
    expect(scheduledDates({ frequency: 'every_n_weeks', interval: 2, startDate: '2026-03-02' }, '2026-03-31').map((d) => d.originalDate)).toEqual(['2026-03-02', '2026-03-16', '2026-03-30']);
    expect(scheduledDates({ frequency: 'monthly_last', startDate: '2026-02-01' }, '2026-04-30').map((d) => d.originalDate)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    expect(scheduledDates({ frequency: 'every_n_months', interval: 3, anchorDay: 15, startDate: '2026-01-15' }, '2026-07-31').map((d) => d.originalDate)).toEqual(['2026-01-15', '2026-04-15', '2026-07-15']);
    expect(scheduledDates({ frequency: 'yearly', startDate: '2024-02-29' }, '2026-12-31').map((d) => d.originalDate)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28']);
    expect(() => scheduledDates({ frequency: 'every_n_weeks', interval: 0, startDate: '2026-03-02' }, '2026-03-16')).toThrow(RangeError);
  });

  test('GT-62: a weekend moves the due date, and the key stays', () => {
    expect(shiftForNonWorkingDay('2026-10-31', 'previous')).toBe('2026-10-30');
    expect(shiftForNonWorkingDay('2026-11-01', 'previous')).toBe('2026-10-30');
    expect(shiftForNonWorkingDay('2026-10-31', 'next')).toBe('2026-11-02');
    expect(shiftForNonWorkingDay('2026-11-01', 'next')).toBe('2026-11-02');
    expect(shiftForNonWorkingDay('2026-10-31')).toBe('2026-10-31');
    const [first] = scheduledDates({ frequency: 'monthly_day', anchorDay: 31, startDate: '2026-10-01', nonWorkingDay: 'previous' }, '2026-10-31');
    expect(first).toEqual({ originalDate: '2026-10-31', dueDate: '2026-10-30' });
  });

  test('GT-30: an edit changes only later, planned, unedited occurrences (BR-08.6)', () => {
    const schedule = { frequency: 'monthly_day', anchorDay: 31, startDate: '2026-01-31' } as const;
    const stored: StoredOccurrence[] = scheduledDates(schedule, '2027-02-01').map((date) => ({
      ...date,
      id: date.originalDate,
      status: date.originalDate < '2026-06-01' ? 'completed' : 'planned',
      isEdited: date.originalDate === '2026-07-31',
    }));
    const first = regenerate(schedule, stored, '2026-06-01', '2027-02-01');
    expect(first.insert).toEqual([]);
    expect(first.cancel).toEqual([]);
    expect(first.update.map((date) => date.originalDate)).toEqual(['2026-06-30', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31']);

    // AC-08.1: running it again adds nothing.
    const fresh = regenerate(schedule, stored, '2020-01-01', '2027-02-01');
    expect(fresh.insert).toEqual([]);

    // An end date cancels what the rule no longer produces.
    const ended = regenerate({ ...schedule, endDate: '2026-09-30' }, stored, '2026-06-01', '2027-02-01');
    expect(ended.cancel).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31']);
  });
});

describe('matching (§9.5)', () => {
  const out = { accountId: 'current', direction: 'out', amount: 5000 } as const;

  test('GT-68: the window for a weekly rule is 3 days, and for a monthly one 5', () => {
    const weekly = matchingWindowDays({ frequency: 'weekly' });
    expect(weekly).toBe(3);
    expect(matchingWindowDays({ frequency: 'monthly_day' })).toBe(5);
    expect(matchingWindowDays({ frequency: 'yearly' })).toBe(5);
    const mondays = ['2026-03-02', '2026-03-09', '2026-03-16'].map((dueDate) => item({ dueDate, amount: 5000, windowDays: weekly }));
    expect(suggestMatches({ ...out, date: '2026-03-05' }, mondays).map((s) => s.item.dueDate)).toEqual(['2026-03-02']);
    expect(suggestMatches({ ...out, date: '2026-03-06' }, mondays).map((s) => s.item.dueDate)).toEqual(['2026-03-09']);
  });

  test('M-3: fixed ±10 %, estimated ±30 %, by exact integers', () => {
    const fixed = item({ amount: 10000 });
    const estimated = item({ amount: 10000, amountType: 'estimated' });
    const at = (amount: number, target: PlannedItem) => suggestMatches({ date: '2026-03-25', accountId: 'current', direction: 'out', amount }, [target]).length;
    expect([at(11000, fixed), at(11001, fixed), at(9000, fixed), at(8999, fixed)]).toEqual([1, 0, 1, 0]);
    expect([at(13000, estimated), at(13001, estimated)]).toEqual([1, 0]);
  });

  test('M-1: same account and same direction; a transfer rule matches either side', () => {
    const expense = item({});
    const salary = item({ kind: 'income', fromAccountId: null, toAccountId: 'current', isPayday: true, payer: 'acme', amount: 200000 });
    const transfer = item({ kind: 'transfer', toAccountId: 'savings', amount: 30000 });
    const on = (accountId: string, direction: 'in' | 'out', amount: number, target: PlannedItem) => suggestMatches({ date: '2026-03-25', accountId, direction, amount, payer: 'acme' }, [target]).length;
    expect(on('other', 'out', 60000, expense)).toBe(0);
    expect(on('current', 'in', 60000, expense)).toBe(0);
    expect(on('current', 'in', 200000, salary)).toBe(1);
    expect(on('current', 'out', 30000, transfer)).toBe(1);
    expect(on('savings', 'in', 30000, transfer)).toBe(1);
  });

  test('GT-64: payday income matches on payer, any amount, and says when it is out of range', () => {
    const salary = item({ kind: 'income', fromAccountId: null, toAccountId: 'current', isPayday: true, payer: 'acme ood', amount: 200000, expectedMin: 180000, expectedMax: 220000 });
    const at = (amount: number, payer: string | null, date = '2026-03-24') => suggestMatches({ date, accountId: 'current', direction: 'in', amount, payer }, [salary]);
    expect(at(214000, 'acme ood')[0]?.outsideExpectedRange).toBe(false);
    expect(at(260000, 'acme ood')[0]?.outsideExpectedRange).toBe(true);
    expect(at(200000, 'someone else', '2026-03-25')).toEqual([]);
    expect(at(200000, null)).toEqual([]);
  });

  test('M-6: the nearest due date first, then the earliest original date', () => {
    const near = item({ id: 'near', dueDate: '2026-03-25', originalDate: '2026-03-25' });
    const far = item({ id: 'far', dueDate: '2026-03-22', originalDate: '2026-03-22' });
    const later = item({ id: 'later', dueDate: '2026-03-25', originalDate: '2026-03-28' });
    expect(suggestMatches({ date: '2026-03-25', accountId: 'current', direction: 'out', amount: 60000 }, [later, far, near]).map((s) => s.item.id)).toEqual(['near', 'later', 'far']);
  });

  test('M-7: a look-alike actual is flagged, and payday income is not', () => {
    const rent = item({ id: 'rent', windowDays: 5 });
    const pay = { transactionId: 't', date: '2026-03-24', accountId: 'current', direction: 'out', amount: 60000 } as const;
    expect(possibleDoubleCounts([rent], [pay])).toEqual([{ item: rent, transactionId: 't' }]);
    expect(possibleDoubleCounts([rent], [{ ...pay, date: '2026-03-19' }])).toEqual([]);
    expect(possibleDoubleCounts([rent], [{ ...pay, amount: 70000 }])).toEqual([]);
  });
});

describe('budgets (FR-07)', () => {
  test('BR-07.5: Scheduled counts only what is still due in the month', () => {
    const food = item({ id: 'a', dueDate: '2026-03-25', lines: [{ categoryId: 'food', amount: 2000 }] });
    const past = item({ id: 'b', dueDate: '2026-03-05', lines: [{ categoryId: 'food', amount: 3000 }] });
    const nextMonth = item({ id: 'c', dueDate: '2026-04-01', lines: [{ categoryId: 'food', amount: 4000 }] });
    const other = item({ id: 'd', dueDate: '2026-03-25', lines: [{ categoryId: 'rent', amount: 5000 }] });
    expect(scheduledInMonth([food, past, nextMonth, other], new Set(['food']), '2026-03', '2026-03-20')).toBe(2000);
  });

  test('BR-07.7: exact integer thresholds (GT-57)', () => {
    expect(thresholdReached(23999, 30000, 80)).toBe(false);
    expect(thresholdReached(24000, 30000, 80)).toBe(true);
  });
});

describe('goals (§8)', () => {
  const allocation = (goalId: string, amount: number, goalOrder: number) => ({ goalId, accountId: 'savings', amount, goalOrder });

  test('AC-09.7: backed amounts sum exactly to the positive balance, ties to the earlier goal', () => {
    const three = [allocation('A', 40000, 1), allocation('B', 40000, 2), allocation('C', 40000, 3)];
    expect(Object.fromEntries(backedOnAccount(100001, three))).toEqual({ A: 33334, B: 33334, C: 33333 });
    const uneven = [allocation('X', 100, 2), allocation('Y', 200, 1)];
    const backed = backedOnAccount(150, uneven);
    expect([...backed.values()].reduce((a, b) => a + b, 0)).toBe(150);
    expect(Object.fromEntries(backedOnAccount(-500, three))).toEqual({ A: 0, B: 0, C: 0 });
    expect(Object.fromEntries(backedOnAccount(200000, three))).toEqual({ A: 40000, B: 40000, C: 40000 });
  });

  test('G-V2: an allocation must fit, and none grow during a shortfall', () => {
    expect(() => assertCanAllocate(100000, 80000, 20000)).not.toThrow();
    expect(() => assertCanAllocate(100000, 80000, 30000)).toThrow(AllocationExceedsUnallocated);
    expect(() => assertCanAllocate(50000, 80000, 1)).toThrow(AllocationExceedsUnallocated);
    expect(() => assertCanAllocate(-100, 0, 1)).toThrow(AllocationExceedsUnallocated);
    expect(() => assertCanAllocate(100, 0, 0)).toThrow(RangeError);
  });

  test('G-T2: the allocations to move with a transfer close the shortfall exactly', () => {
    const both = [allocation('E', 120000, 1), allocation('V', 80000, 2)];
    const move = allocationsToMove(150000, both);
    expect(Object.fromEntries(move)).toEqual({ E: 30000, V: 20000 });
    expect(allocationsToMove(200000, both).size).toBe(0);
  });

  test('§8.8: the worked example', () => {
    const house = goalProjection({ target: 2000000, progress: 200000, monthly: 100000, targetDate: '2027-12-31', today: '2026-03-15' });
    expect(house).toMatchObject({ remaining: 1800000, reached: false, monthsNeeded: 18, estimatedCompletion: '2027-08-31', requiredMonthly: 81819, behindSchedule: false });
    expect(goalProjection({ target: 2000000, progress: 200000, monthly: 50000, targetDate: '2027-12-31', today: '2026-03-15' })?.behindSchedule).toBe(true);
    expect(goalProjection({ target: 100, progress: 100, monthly: 50, targetDate: null, today: '2026-03-15' })).toMatchObject({ reached: true, monthsNeeded: null, requiredMonthly: null });
    expect(goalProjection({ target: null, progress: 100, monthly: 50, targetDate: null, today: '2026-03-15' })).toBeNull();
  });
});

describe('projection (FR-13)', () => {
  function ledger(balance: number, owed = 0) {
    const chart = new Chart();
    chart.add({ id: 'OBE', kind: 'equity', name: 'OBE', systemCode: 'OBE' });
    const open = { class: 'cash', type: 'current', spendable: true, cardReserve: false, openingDate: '2026-01-01' } as const;
    chart.add({ id: 'current', kind: 'asset', name: 'Current', account: open });
    chart.add({ id: 'card', kind: 'liability', name: 'Card', account: { class: 'liability', type: 'card', spendable: false, cardReserve: true, openingDate: '2026-01-01' } });
    const opening = (id: string, accountId: string, amount: number): Transaction => ({
      id,
      date: '2026-01-01',
      kind: 'opening_balance',
      status: 'posted',
      postings: [{ ledgerAccountId: accountId, amount }, { ledgerAccountId: 'OBE', amount: -amount }],
    });
    return new Ledger(chart, [opening('a', 'current', balance), ...(owed ? [opening('b', 'card', -owed)] : [])]);
  }

  test('AC-13.1: the brief example', () => {
    const planned = [item({ id: 'pay', kind: 'income', fromAccountId: null, toAccountId: 'current', amount: 150000, dueDate: '2026-03-25' }), item({ id: 'bills', amount: 90000, dueDate: '2026-03-28' })];
    const result = projection({ ledger: ledger(120000), today: '2026-03-20', days: 30, planned });
    expect(result.days.at(-1)).toMatchObject({ withIncome: 180000, commitmentsOnly: 30000 });
    expect(result.lowest).toEqual({ date: '2026-03-28', amount: 30000 });
  });

  test('GT-69: a reserved card comes off on day 0, or on its repayment date', () => {
    const none = projection({ ledger: ledger(110000, 30000), today: '2026-03-31', days: 30, planned: [] });
    expect(none.days[0]!.commitmentsOnly).toBe(80000);
    expect(none.lowest.amount).toBe(80000);
    const repayment = item({ id: 'pay', kind: 'transfer', toAccountId: 'card', amount: 30000, dueDate: '2026-04-15' });
    const scheduled = projection({ ledger: ledger(110000, 30000), today: '2026-03-31', days: 30, planned: [repayment] });
    expect(scheduled.days[0]!.commitmentsOnly).toBe(110000);
    expect(scheduled.lowest).toEqual({ date: '2026-04-15', amount: 80000 });
  });

  test('GT-56: overdue outflows land on day 0; expected income only on its own line', () => {
    const planned = [item({ id: 'old', amount: 1000, dueDate: '2026-03-01' }), item({ id: 'invoice', kind: 'income', fromAccountId: null, toAccountId: 'current', amount: 150000, dueDate: '2026-03-28' }), item({ id: 'rent', amount: 60000, dueDate: '2026-04-01' })];
    const result = projection({ ledger: ledger(110000), today: '2026-03-20', days: 31, planned });
    expect(result.days[0]!.commitmentsOnly).toBe(109000);
    expect(result.days.at(-1)).toMatchObject({ date: '2026-04-19', commitmentsOnly: 49000, withIncome: 199000 });
  });
});
