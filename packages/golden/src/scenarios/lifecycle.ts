import type { Scenario, TransactionOp } from '../scenario.ts';

type Expense = Extract<TransactionOp, { op: 'expense' }>;

const MARCH = { from: '2026-03-01', to: '2026-03-31' } as const;
const APRIL = { from: '2026-04-01', to: '2026-04-30' } as const;
const FOOD: Expense = { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Food', '45.60']], ref: 'food' };
const RENT: Expense = { op: 'expense', date: '2026-03-25', account: 'Current', lines: [['Rent', '600.00']], ref: 'rent' };

/** В§6.9 (GT-43, GT-44) and the E-38, E-39 examples: edits, voids, the trash and restoring. */
export const lifecycle: Scenario[] = [
  {
    id: 'GT-43',
    title: 'Edit across a month boundary',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-31', account: 'Current', lines: [['Food', '50.00']], ref: 'food' },
      { op: 'edit', ref: 'food', to: { op: 'expense', date: '2026-04-01', account: 'Current', lines: [['Food', '50.00']] } },
    ],
    checks: [
      {
        at: '2026-04-30',
        balances: { Current: '950.00' },
        netWorth: '3050.00',
        flows: [
          { ...MARCH, expenses: '0.00', cashChange: '0.00' },
          { ...APRIL, expenses: '50.00', cashChange: '-50.00', netWorthIdentity: true },
        ],
        budgets: [
          { category: 'Food', month: '2026-03', limit: '250.00', spent: '0.00', display: '0.0 %' },
          { category: 'Food', month: '2026-04', limit: '250.00', spent: '50.00', display: '20.0 %' },
        ],
      },
    ],
  },
  {
    id: 'E-38 (amount)',
    title: 'Editing an amount applies only the difference',
    base: 'B0',
    steps: [FOOD, { op: 'edit', ref: 'food', to: { ...FOOD, lines: [['Food', '54.60']] } }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '945.40' },
        netWorth: '3045.40',
        safeToSpend: '1045.40',
        flows: [{ ...MARCH, expenses: '54.60', cashChange: '-54.60', netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'E-38 (account)',
    title: 'Moving an expense from Current to a card moves it from assets to liabilities',
    base: 'B0',
    steps: [{ op: 'account', name: 'Card', type: 'card' }, FOOD, { op: 'edit', ref: 'food', to: { ...FOOD, account: 'Card' } }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '1000.00', Card: '45.60' },
        assets: '3100.00',
        liabilities: '45.60',
        netWorth: '3054.40',
        safeToSpend: '1054.40',
        flows: [{ ...MARCH, expenses: '45.60', cashChange: '0.00', netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'GT-44 (void)',
    title: 'Voiding removes every effect',
    base: 'B0',
    steps: [RENT, { op: 'void', ref: 'rent' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '1000.00' },
        netWorth: '3100.00',
        safeToSpend: '1100.00',
        flows: [{ ...MARCH, expenses: '0.00', cashChange: '0.00', netWorthIdentity: true }],
      },
    ],
    deferred: [{ what: 'the occurrence returns to Planned when its transaction is voided', stage: 5 }],
  },
  {
    id: 'GT-44 (restore)',
    title: 'Restoring a voided transaction brings back exactly the same figures',
    base: 'B0',
    steps: [RENT, { op: 'void', ref: 'rent' }, { op: 'restore', ref: 'rent' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '400.00' },
        netWorth: '2500.00',
        safeToSpend: '500.00',
        flows: [{ ...MARCH, expenses: '600.00', cashChange: '-600.00', netWorthIdentity: true }],
        budgets: [{ category: 'Rent', month: '2026-03', limit: '600.00', spent: '600.00', display: '100.0 %' }],
      },
    ],
    deferred: [{ what: 'the occurrence is Completed again after the restore; the edge case of a newly matched occurrence', stage: 5 }],
  },
  {
    id: 'AC-19.1',
    title: 'Deleting then restoring a transaction yields identical balances',
    base: 'B0',
    steps: [FOOD, { op: 'trash', ref: 'food' }, { op: 'restore', ref: 'food' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '954.40', 'Cash wallet': '100.00', Savings: '2000.00' },
        netWorth: '3054.40',
        safeToSpend: '1054.40',
        flows: [{ ...MARCH, expenses: '45.60', byCategory: { Food: '45.60' }, netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'E-39 (trash)',
    title: 'A trashed transaction counts nowhere',
    base: 'B0',
    steps: [FOOD, RENT, { op: 'trash', ref: 'food' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '400.00' },
        netWorth: '2500.00',
        flows: [{ ...MARCH, expenses: '600.00', byCategory: { Food: '0.00', Rent: '600.00' }, netWorthIdentity: true }],
      },
    ],
  },
];
