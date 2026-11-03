import type { Scenario } from '../scenario.ts';

const MARCH = { from: '2026-03-01', to: '2026-03-31' } as const;

/** §6.6: refunds and reversals. */
export const refunds: Scenario[] = [
  {
    id: 'GT-22',
    title: 'Full refund in the same month',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-05', account: 'Current', lines: [['Shopping', '59.99']], ref: 'purchase' },
      { op: 'refund', date: '2026-03-09', account: 'Current', lines: [['Shopping', '59.99']], of: 'purchase' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '1000.00' },
        netWorth: '3100.00',
        safeToSpend: '1100.00',
        flows: [{ ...MARCH, income: '0.00', expenses: '0.00' }],
        budgets: [{ category: 'Shopping', month: '2026-03', limit: '150.00', spent: '0.00', display: '0.0 %' }],
      },
    ],
  },
  {
    id: 'GT-23',
    title: 'Partial refund',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-05', account: 'Current', lines: [['Clothing', '45.00']], ref: 'purchase' },
      { op: 'refund', date: '2026-03-09', account: 'Current', lines: [['Clothing', '15.00']], of: 'purchase' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '970.00' },
        netWorth: '3070.00',
        safeToSpend: '1070.00',
        flows: [{ ...MARCH, expenses: '30.00' }],
        budgets: [{ category: 'Shopping', month: '2026-03', limit: '150.00', spent: '30.00', display: '20.0 %' }],
      },
    ],
  },
  {
    id: 'GT-24',
    title: 'Refund in a later month',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-25', account: 'Current', lines: [['Shopping', '100.00']], ref: 'purchase' },
      { op: 'refund', date: '2026-04-03', account: 'Current', lines: [['Shopping', '100.00']], of: 'purchase' },
    ],
    checks: [
      {
        at: '2026-03-31',
        netWorth: '3000.00',
        flows: [{ ...MARCH, expenses: '100.00' }],
        budgets: [{ category: 'Shopping', month: '2026-03', limit: '150.00', spent: '100.00', display: '66.6 %' }],
      },
      { at: '2026-04-03', safeToSpend: '1100.00' },
      {
        at: '2026-04-30',
        netWorth: '3100.00',
        flows: [
          { from: '2026-04-01', to: '2026-04-30', expenses: '-100.00', netResult: '100.00', netWorthIdentity: true },
          { from: '2026-03-01', to: '2026-04-30', expenses: '0.00' },
        ],
        budgets: [{ category: 'Shopping', month: '2026-04', limit: '150.00', spent: '-100.00', display: '0.0 %' }],
      },
    ],
  },
  {
    id: 'GT-25',
    title: 'Overspending and a refund (ledger and budget part)',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Food', '150.00']] },
      { op: 'expense', date: '2026-03-15', account: 'Current', lines: [['Food', '60.00']] },
      { op: 'expense', date: '2026-03-18', account: 'Current', lines: [['Food', '50.00']] },
      { op: 'refund', date: '2026-03-19', account: 'Current', lines: [['Food', '30.00']] },
      { op: 'expense', date: '2026-03-20', account: 'Current', lines: [['Food', '25.00']] },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '745.00' },
        netWorth: '2845.00',
        safeToSpend: '845.00',
        flows: [{ ...MARCH, expenses: '255.00' }],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '255.00', display: '102.0 %' }],
      },
    ],
    deferred: [{ what: 'exactly 2 threshold alerts (80 % and 100 %) need budget alert events', stage: 5 }],
  },
  {
    id: 'GT-26',
    title: 'Refund to a different account',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Card', type: 'card' },
      { op: 'expense', date: '2026-03-05', account: 'Card', lines: [['Shopping', '80.00']], ref: 'purchase' },
      { op: 'refund', date: '2026-03-12', account: 'Current', lines: [['Shopping', '80.00']], of: 'purchase' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Card: '80.00', Current: '1080.00' },
        assets: '3180.00',
        liabilities: '80.00',
        netWorth: '3100.00',
        safeToSpend: '1100.00',
        flows: [{ ...MARCH, expenses: '0.00', cashChange: '80.00' }],
      },
    ],
  },
  {
    id: 'GT-27',
    title: 'Income reversal',
    base: 'B0',
    steps: [
      { op: 'income', date: '2026-03-10', account: 'Current', lines: [['Salary', '2000.00']], ref: 'salary' },
      { op: 'refund', date: '2026-03-20', account: 'Current', lines: [['Salary', '150.00']], of: 'salary' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '2850.00' },
        netWorth: '4950.00',
        safeToSpend: '2950.00',
        flows: [{ ...MARCH, income: '1850.00', expenses: '0.00' }],
      },
    ],
  },
];
