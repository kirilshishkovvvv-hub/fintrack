import type { Scenario } from '../scenario.ts';

const MARCH = { from: '2026-03-01', to: '2026-03-31' } as const;
const CARD = { op: 'account', name: 'Card', type: 'card' } as const;

/** §6.4 and §6.5: credit cards, loans and personal debts. */
export const cardsAndDebts: Scenario[] = [
  {
    id: 'GT-11',
    title: 'Card purchase and full repayment',
    base: 'B0',
    steps: [
      CARD,
      { op: 'expense', date: '2026-03-05', account: 'Card', lines: [['Shopping', '80.00']] },
      { op: 'transfer', date: '2026-03-25', from: 'Current', to: 'Card', amount: '80.00' },
    ],
    checks: [
      { at: '2026-03-06', safeToSpend: '1020.00' },
      {
        at: '2026-03-31',
        balances: { Current: '920.00', Card: '0.00' },
        assets: '3020.00',
        liabilities: '0.00',
        netWorth: '3020.00',
        safeToSpend: '1020.00',
        flows: [{ ...MARCH, expenses: '80.00', netResult: '-80.00', cashChange: '-80.00' }],
        budgets: [{ category: 'Shopping', month: '2026-03', limit: '150.00', spent: '80.00', display: '53.3 %' }],
      },
    ],
  },
  {
    id: 'GT-12',
    title: 'Card refund and partial repayment',
    base: 'B0',
    steps: [
      CARD,
      { op: 'expense', date: '2026-03-05', account: 'Card', lines: [['Shopping', '80.00']] },
      { op: 'refund', date: '2026-03-08', account: 'Card', lines: [['Shopping', '20.00']] },
      { op: 'transfer', date: '2026-03-25', from: 'Current', to: 'Card', amount: '50.00' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Card: '10.00', Current: '950.00' },
        assets: '3050.00',
        liabilities: '10.00',
        netWorth: '3040.00',
        safeToSpend: '1040.00',
        flows: [{ ...MARCH, expenses: '60.00', netResult: '-60.00', cashChange: '-50.00', netWorthIdentity: true }],
        budgets: [{ category: 'Shopping', month: '2026-03', limit: '150.00', spent: '60.00', display: '40.0 %' }],
      },
    ],
  },
  {
    id: 'GT-13',
    title: 'Card interest and annual fee',
    base: 'B0',
    steps: [
      { ...CARD, opening: '500.00' },
      {
        op: 'expense',
        date: '2026-03-28',
        account: 'Card',
        lines: [
          ['Interest', '12.40'],
          ['Bank fees', '30.00'],
        ],
      },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Card: '542.40' },
        assets: '3100.00',
        liabilities: '542.40',
        netWorth: '2557.60',
        safeToSpend: '557.60',
        flows: [{ ...MARCH, expenses: '42.40', netResult: '-42.40', cashChange: '0.00', netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'GT-14',
    title: 'Cash advance',
    base: 'B0',
    steps: [
      CARD,
      { op: 'transfer', date: '2026-03-10', from: 'Card', to: 'Cash wallet', amount: '200.00', fee: ['Bank fees', '6.00'] },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Card: '206.00', 'Cash wallet': '300.00' },
        assets: '3300.00',
        liabilities: '206.00',
        netWorth: '3094.00',
        safeToSpend: '1094.00',
        flows: [{ ...MARCH, expenses: '6.00', netResult: '-6.00', cashChange: '200.00' }],
      },
    ],
  },
  {
    id: 'GT-15',
    title: 'Card overpayment',
    base: 'B0',
    steps: [{ ...CARD, opening: '30.00' }, { op: 'transfer', date: '2026-03-10', from: 'Current', to: 'Card', amount: '50.00' }],
    checks: [
      { at: '2026-03-09', safeToSpend: '1070.00' },
      {
        at: '2026-03-31',
        balances: { Card: '-20.00', Current: '950.00' },
        assets: '3050.00',
        liabilities: '-20.00',
        netWorth: '3070.00',
        safeToSpend: '1050.00',
        flows: [{ ...MARCH, income: '0.00', expenses: '0.00', cashChange: '-50.00' }],
      },
    ],
  },
  {
    id: 'GT-17',
    title: 'Card instalment plan (ledger part)',
    base: 'B0',
    steps: [
      { op: 'account', name: 'TV plan', type: 'loan' },
      { op: 'expense', date: '2026-03-15', account: 'TV plan', lines: [['Electronics', '600.00']] },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { 'TV plan': '600.00', Current: '1000.00' },
        assets: '3100.00',
        liabilities: '600.00',
        netWorth: '2500.00',
        flows: [{ ...MARCH, expenses: '600.00', netResult: '-600.00', cashChange: '0.00', byCategory: { Electronics: '600.00' } }],
      },
    ],
    deferred: [{ what: 'Safe to Spend 1,000 needs the planned 15 Apr instalment', stage: 5 }],
  },
  {
    id: 'GT-18',
    title: 'Loan instalment split',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Loan', type: 'loan', opening: '8000.00' },
      {
        op: 'debtPayment',
        date: '2026-03-10',
        from: 'Current',
        to: 'Loan',
        principal: '320.00',
        extras: [
          ['Interest', '75.00'],
          ['Bank fees', '5.00'],
        ],
      },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '600.00', Loan: '7680.00' },
        assets: '2700.00',
        liabilities: '7680.00',
        netWorth: '-4980.00',
        safeToSpend: '700.00',
        flows: [{ ...MARCH, expenses: '80.00', netResult: '-80.00', cashChange: '-400.00', netWorthIdentity: true }],
      },
    ],
  },
  {
    id: 'GT-19',
    title: 'Loan disbursement',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Loan', type: 'loan', date: '2026-03-10' },
      { op: 'transfer', date: '2026-03-10', from: 'Loan', to: 'Current', amount: '10000.00' },
    ],
    checks: [
      {
        at: '2026-03-31',
        balances: { Current: '11000.00', Loan: '10000.00' },
        assets: '13100.00',
        liabilities: '10000.00',
        netWorth: '3100.00',
        safeToSpend: '11100.00',
        flows: [{ ...MARCH, income: '0.00', cashChange: '10000.00' }],
      },
    ],
  },
  {
    id: 'GT-21',
    title: 'Shared bill and repayment',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Lent to friends', type: 'lent' },
      {
        op: 'split',
        date: '2026-03-14',
        lines: [
          ['Current', '-120.00'],
          ['Food', '40.00'],
          ['Lent to friends', '80.00'],
        ],
      },
      { op: 'transfer', date: '2026-03-22', from: 'Lent to friends', to: 'Current', amount: '80.00' },
    ],
    checks: [
      {
        at: '2026-03-14',
        balances: { Current: '880.00', 'Lent to friends': '80.00' },
        netWorth: '3060.00',
        safeToSpend: '980.00',
        flows: [{ from: '2026-03-01', to: '2026-03-14', expenses: '40.00' }],
        budgets: [{ category: 'Food', month: '2026-03', limit: '250.00', spent: '40.00', display: '16.0 %' }],
      },
      {
        at: '2026-03-31',
        balances: { Current: '960.00', 'Lent to friends': '0.00' },
        netWorth: '3060.00',
        safeToSpend: '1060.00',
        flows: [{ ...MARCH, expenses: '40.00', cashChange: '-40.00' }],
      },
    ],
  },
];
