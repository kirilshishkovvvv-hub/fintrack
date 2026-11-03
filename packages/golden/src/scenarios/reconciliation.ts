import type { Op, Scenario } from '../scenario.ts';

const MARCH = { from: '2026-03-01', to: '2026-03-31' } as const;

/** GT-40's activity on Current, before the statement is checked. */
const GT40_ACTIVITY: Op[] = [
  { op: 'income', date: '2026-03-10', account: 'Current', lines: [['Salary', '2000.00']] },
  { op: 'expense', date: '2026-03-12', account: 'Current', lines: [['Rent', '600.00']] },
  { op: 'expense', date: '2026-03-15', account: 'Current', lines: [['Food', '148.83']], ref: 'food' },
  { op: 'reconcile', account: 'Current', date: '2026-03-31', statement: '2243.17', adjustTo: 'ADJ' },
];

/** §6.9 (GT-40 to GT-42, GT-45): reconciliation, quick balance updates, archiving and merging. */
export const reconciliation: Scenario[] = [
  {
    id: 'GT-40',
    title: 'Reconciliation with an adjustment',
    base: 'B0',
    steps: GT40_ACTIVITY,
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '2243.17' },
        assets: '4343.17',
        netWorth: '4343.17',
        safeToSpend: '2343.17',
        flows: [{ ...MARCH, income: '2000.00', expenses: '748.83', netResult: '1251.17', cashChange: '1243.17', netWorthIdentity: true }],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '148.83', display: '59.5 %' }],
      },
    ],
  },
  {
    id: 'GT-41',
    title: 'Untracked cash spending ("I spent it")',
    base: 'B0',
    steps: [{ op: 'balanceUpdate', account: 'Cash wallet', date: '2026-03-20', actual: '65.00', category: 'Untracked spending' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { 'Cash wallet': '65.00' },
        netWorth: '3065.00',
        safeToSpend: '1065.00',
        flows: [{ ...MARCH, expenses: '35.00', byCategory: { 'Untracked spending': '35.00' }, netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'GT-41 (unexplained)',
    title: 'Untracked cash difference left unexplained',
    base: 'B0',
    steps: [{ op: 'balanceUpdate', account: 'Cash wallet', date: '2026-03-20', actual: '65.00' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { 'Cash wallet': '65.00' },
        netWorth: '3065.00',
        flows: [{ ...MARCH, expenses: '0.00', netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'GT-42',
    title: 'Editing a reconciled transaction after unlocking it',
    base: 'B0',
    steps: [
      ...GT40_ACTIVITY,
      { op: 'edit', ref: 'food', to: { op: 'expense', date: '2026-03-15', account: 'Current', lines: [['Food', '158.83']] } },
    ],
    // The lock, the audited unlock and the "broken, −10.00" state are asserted by the API tests.
    checks: [{ at: '2026-03-31', balances: { Current: '2233.17' }, flows: [{ ...MARCH, expenses: '758.83', netWorthIdentity: true }] }],
  },
  {
    id: 'GT-45 (a)',
    title: 'Archiving an account once its balance is 0',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Old bank', type: 'cash', opening: '12.34' },
      { op: 'transfer', date: '2026-03-02', from: 'Old bank', to: 'Current', amount: '12.34' },
      { op: 'archive', name: 'Old bank' },
    ],
    checks: [{ at: '2026-03-31', balances: { Current: '1012.34', 'Old bank': '0.00' }, netWorth: '3112.34' }],
  },
  {
    id: 'GT-45 (b)',
    title: 'Merging categories changes only the breakdown',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-05', account: 'Current', lines: [['Food', '100.00']] },
      { op: 'expense', date: '2026-03-06', account: 'Current', lines: [['Restaurants', '50.00']] },
      { op: 'merge', from: 'Restaurants', into: 'Food' },
    ],
    checks: [{ at: '2026-03-31', flows: [{ ...MARCH, expenses: '150.00', byCategory: { Food: '150.00', Restaurants: '0.00' }, netWorthIdentity: true }] }],
  },
];
