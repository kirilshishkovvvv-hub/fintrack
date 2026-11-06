/** Reports against the ledger's definitions (FR-15). GT-60's own figures are in the golden scenarios. */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  averageMonthlyExpenses,
  build,
  categoryReport,
  Chart,
  formatPercentChange,
  incomeAndExpensesByMonth,
  Ledger,
  monthsBetween,
  netWorthByMonth,
  percentChangeTenths,
  type Transaction,
} from '../src/index.ts';

function chart() {
  const value = new Chart();
  for (const code of ['OBE', 'ADJ', 'VAL', 'CNV'] as const) value.add({ id: code, kind: 'equity', name: code, systemCode: code });
  const opened = { class: 'cash', type: 'current', spendable: true, cardReserve: false, openingDate: '2026-01-01' } as const;
  value.add({ id: 'current', kind: 'asset', name: 'Current', account: opened });
  value.add({ id: 'salary', kind: 'income', name: 'Salary', category: {} });
  value.add({ id: 'food', kind: 'expense', name: 'Food', category: {} });
  value.add({ id: 'groceries', kind: 'expense', name: 'Groceries', category: { parentId: 'food' } });
  value.add({ id: 'rent', kind: 'expense', name: 'Rent', category: {} });
  return value;
}

describe('months', () => {
  test('monthsBetween crosses years, and is empty if the order is wrong', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-03', '2026-03')).toEqual(['2026-03']);
    expect(monthsBetween('2026-03', '2026-02')).toEqual([]);
  });
});

describe('percent change', () => {
  test('ordinary rounding, signs, and a zero base (GT-60, FR-15)', () => {
    expect(formatPercentChange(percentChangeTenths(150000, 142700))).toBe('−4.9 %');
    expect(formatPercentChange(percentChangeTenths(50000, 57300))).toBe('+14.6 %');
    expect(formatPercentChange(percentChangeTenths(15000, 6000))).toBe('−60.0 %');
    expect(formatPercentChange(percentChangeTenths(0, 100))).toBe('new');
    expect(formatPercentChange(percentChangeTenths(0, 0))).toBe('0.0 %');
    expect(formatPercentChange(percentChangeTenths(1000, 1000))).toBe('0.0 %');
    // From a negative base, a rise is still a rise.
    expect(formatPercentChange(percentChangeTenths(-1000, -500))).toBe('+50.0 %');
    // Half a tenth rounds away from zero.
    expect(percentChangeTenths(2000, 2001)).toBe(1);
    expect(percentChangeTenths(2000, 1999)).toBe(-1);
  });
});

describe('category report', () => {
  test('a parent line includes its subcategories; a refund nets off; the rows sum to Expenses (AC-05.2, AC-15.1)', () => {
    const c = chart();
    const txs: Transaction[] = [
      build.expense({ id: 'a', date: '2026-03-01', accountId: 'current', lines: [{ categoryId: 'food', amount: 1000 }] }),
      build.expense({ id: 'b', date: '2026-03-02', accountId: 'current', lines: [{ categoryId: 'groceries', amount: 2500 }, { categoryId: 'rent', amount: 60000 }] }),
      build.refund(c, { id: 'c', date: '2026-03-03', accountId: 'current', lines: [{ categoryId: 'groceries', amount: 500 }] }),
      build.expense({ id: 'd', date: '2026-04-03', accountId: 'current', lines: [{ categoryId: 'rent', amount: 60000 }] }),
    ];
    const report = categoryReport(new Ledger(c, txs), { from: '2026-03-01', to: '2026-03-31' });
    expect(report.total).toBe(63000);
    expect(report.rows.map((row) => [row.name, row.total, row.own])).toEqual([['Rent', 60000, 60000], ['Food', 3000, 1000]]);
    expect(report.rows[1]!.children).toEqual([{ categoryId: 'groceries', name: 'Groceries', total: 2000 }]);
    expect(report.rows.reduce((sum, row) => sum + row.total, 0)).toBe(report.total);
  });

  test('income has its own report', () => {
    const c = chart();
    const ledger = new Ledger(c, [build.income({ id: 'a', date: '2026-03-01', accountId: 'current', lines: [{ categoryId: 'salary', amount: 200000 }] })]);
    expect(categoryReport(ledger, { from: '2026-03-01', to: '2026-03-31' }, 'income')).toMatchObject({ total: 200000, rows: [{ name: 'Salary', total: 200000 }] });
  });
});

describe('average monthly expenses (FR-15)', () => {
  const flow = (month: string, expenses: number) => ({ month, income: 0, expenses, netResult: -expenses });

  test('GT-57 (b): 100.00 over three full months is 33.33, and stored totals are untouched', () => {
    expect(averageMonthlyExpenses([flow('2026-01', 5000), flow('2026-02', 3000), flow('2026-03', 2000)], '2026-06-15')).toBe(3333);
  });

  test('the partial current month is left out, unless it is all there is', () => {
    expect(averageMonthlyExpenses([flow('2026-05', 1000), flow('2026-06', 9000)], '2026-06-15')).toBe(1000);
    expect(averageMonthlyExpenses([flow('2026-06', 9000)], '2026-06-15')).toBe(9000);
    expect(averageMonthlyExpenses([], '2026-06-15')).toBeNull();
  });
});

describe('every month, whatever happened (properties)', () => {
  const day = fc.integer({ min: 1, max: 28 }).map((value) => String(value).padStart(2, '0'));
  const month = fc.constantFrom('01', '02', '03', '04', '05', '06');
  const action = fc.record({ type: fc.constantFrom('expense', 'income', 'refund', 'adjust'), date: fc.tuple(month, day).map(([m, d]) => `2026-${m}-${d}`), amount: fc.integer({ min: 1, max: 5_000_000 }), category: fc.constantFrom('food', 'groceries', 'rent') });

  const buildAll = (actions: readonly { type: string; date: string; amount: number; category: string }[]) => {
    const c = chart();
    const txs = actions.map((a, index): Transaction => {
      const base = { id: `t${index}`, date: a.date, accountId: 'current' };
      if (a.type === 'income') return build.income({ ...base, lines: [{ categoryId: 'salary', amount: a.amount }] });
      if (a.type === 'refund') return build.refund(c, { ...base, lines: [{ categoryId: a.category, amount: a.amount }] });
      if (a.type === 'adjust') return build.adjustment(c, { id: base.id, date: a.date, accountId: 'current', delta: a.amount });
      return build.expense({ ...base, lines: [{ categoryId: a.category, amount: a.amount }] });
    });
    return new Ledger(c, txs);
  };

  test('AC-15.2: the Net Worth Change identity holds for every month', () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        const points = netWorthByMonth(buildAll(actions), monthsBetween('2026-01', '2026-06'), '2026-12-31');
        for (const point of points) {
          expect(point.identityHolds).toBe(true);
          expect(point.change).toBe(point.netResult + point.otherEffects);
          expect(point.netWorth).toBe(point.assets - point.liabilities);
        }
        for (let index = 1; index < points.length; index += 1) expect(points[index]!.netWorth).toBe(points[index - 1]!.netWorth + points[index]!.change);
      }),
    );
  });

  test('AC-15.1, AC-14.2: the category rows and the monthly flows sum to the same Expenses as the period', () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        const ledger = buildAll(actions);
        const period = { from: '2026-01-01', to: '2026-06-30' };
        const report = categoryReport(ledger, period);
        expect(report.rows.reduce((sum, row) => sum + row.total, 0)).toBe(ledger.expenses(period));
        const flows = incomeAndExpensesByMonth(ledger, monthsBetween('2026-01', '2026-06'));
        expect(flows.reduce((sum, flow) => sum + flow.expenses, 0)).toBe(ledger.expenses(period));
        expect(flows.reduce((sum, flow) => sum + flow.income, 0)).toBe(ledger.income(period));
      }),
    );
  });
});
