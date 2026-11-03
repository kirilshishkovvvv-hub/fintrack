import type { Scenario } from '../scenario.ts';

const MARCH = { from: '2026-03-01', to: '2026-03-31' } as const;

/** §6.2 and §6.3: opening balances, basic operations, transfers. */
export const basics: Scenario[] = [
  {
    id: 'GT-01',
    title: 'Opening balances (baseline)',
    base: 'B0',
    steps: [],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '1000.00', 'Cash wallet': '100.00', Savings: '2000.00' },
        assets: '3100.00',
        liabilities: '0.00',
        netWorth: '3100.00',
        safeToSpend: '1100.00',
        flows: [{ ...MARCH, income: '0.00', expenses: '0.00', netResult: '0.00', cashChange: '0.00', netWorthIdentity: true }],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '0.00', display: '0.0 %' }],
      },
    ],
  },
  {
    id: 'GT-02',
    title: 'Opening balances on liabilities',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Card', type: 'card', opening: '300.00' },
      { op: 'account', name: 'Loan', type: 'loan', opening: '8000.00' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '1000.00', 'Cash wallet': '100.00', Savings: '2000.00', Card: '300.00', Loan: '8000.00' },
        assets: '3100.00',
        liabilities: '8300.00',
        netWorth: '-5200.00',
        safeToSpend: '800.00',
        flows: [{ ...MARCH, income: '0.00', expenses: '0.00', cashChange: '0.00', netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'GT-03',
    title: 'Income and expenses (bank and cash)',
    base: 'B0',
    steps: [
      { op: 'income', date: '2026-03-10', account: 'Current', lines: [['Salary', '2000.00']] },
      { op: 'expense', date: '2026-03-12', account: 'Current', lines: [['Food', '45.60']] },
      { op: 'expense', date: '2026-03-14', account: 'Cash wallet', lines: [['Food', '12.00']] },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '2954.40', 'Cash wallet': '88.00', Savings: '2000.00' },
        assets: '5042.40',
        liabilities: '0.00',
        netWorth: '5042.40',
        safeToSpend: '3042.40',
        flows: [
          { ...MARCH, income: '2000.00', expenses: '57.60', netResult: '1942.40', cashChange: '1942.40', netWorthIdentity: true },
        ],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '57.60', display: '23.0 %' }],
      },
    ],
  },
  {
    id: 'GT-04',
    title: 'Split transaction',
    base: 'B0',
    steps: [
      {
        op: 'expense',
        date: '2026-03-15',
        account: 'Current',
        lines: [
          ['Food', '80.00'],
          ['Household', '30.00'],
          ['Personal care', '10.00'],
        ],
      },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '880.00' },
        assets: '2980.00',
        netWorth: '2980.00',
        safeToSpend: '980.00',
        flows: [
          {
            ...MARCH,
            expenses: '120.00',
            netResult: '-120.00',
            cashChange: '-120.00',
            byCategory: { Food: '80.00', Household: '30.00', 'Personal care': '10.00' },
          },
        ],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '80.00', display: '32.0 %' }],
      },
    ],
  },
  {
    id: 'GT-06',
    title: 'Transfer to savings',
    base: 'B0',
    steps: [{ op: 'transfer', date: '2026-03-12', from: 'Current', to: 'Savings', amount: '200.00' }],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '800.00', Savings: '2200.00' },
        assets: '3100.00',
        netWorth: '3100.00',
        safeToSpend: '900.00',
        flows: [{ ...MARCH, income: '0.00', expenses: '0.00', netResult: '0.00', cashChange: '0.00' }],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '0.00', display: '0.0 %' }],
      },
    ],
  },
  {
    id: 'GT-07',
    title: 'Transfer with a fee',
    base: 'B0',
    steps: [
      { op: 'transfer', date: '2026-03-12', from: 'Current', to: 'Savings', amount: '500.00', fee: ['Bank fees', '1.50'] },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '498.50', Savings: '2500.00' },
        assets: '3098.50',
        netWorth: '3098.50',
        safeToSpend: '598.50',
        flows: [{ ...MARCH, expenses: '1.50', netResult: '-1.50', cashChange: '-1.50', byCategory: { 'Bank fees': '1.50' } }],
      },
    ],
  },
  {
    id: 'GT-08',
    title: 'ATM withdrawal, cash spending, cash deposit',
    base: 'B0',
    steps: [
      { op: 'transfer', date: '2026-03-10', from: 'Current', to: 'Cash wallet', amount: '100.00', fee: ['Bank fees', '2.00'] },
      { op: 'expense', date: '2026-03-11', account: 'Cash wallet', lines: [['Food', '30.00']] },
      { op: 'transfer', date: '2026-03-18', from: 'Cash wallet', to: 'Current', amount: '50.00' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '948.00', 'Cash wallet': '120.00', Savings: '2000.00' },
        assets: '3068.00',
        netWorth: '3068.00',
        safeToSpend: '1068.00',
        flows: [
          {
            ...MARCH,
            expenses: '32.00',
            netResult: '-32.00',
            cashChange: '-32.00',
            byCategory: { 'Bank fees': '2.00', Food: '30.00' },
          },
        ],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '30.00', display: '12.0 %' }],
      },
    ],
  },
];
