import type { Op, Scenario } from '../scenario.ts';

const CARD = { op: 'account', name: 'Card', type: 'card', opening: '300.00' } as const;
const RENT_25: Op = { op: 'rule', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '600.00']], day: 25 };

/** §6.7: planned items never touch actual figures, and turn into actuals exactly once. */
const plannedVersusActual: Scenario[] = [
  {
    id: 'GT-28',
    title: "Planned items don't affect actual figures",
    base: 'B0',
    steps: [RENT_25],
    checks: [
      {
        at: '2026-03-20',
        balances: { Current: '1000.00', 'Cash wallet': '100.00', Savings: '2000.00' },
        netWorth: '3100.00',
        flows: [{ from: '2026-03-01', to: '2026-03-31', expenses: '0.00' }],
        scheduled: [{ category: 'Rent', month: '2026-03', amount: '600.00' }],
        safeToSpend: '500.00',
        windowTo: '2026-04-19',
      },
    ],
  },
  {
    id: 'GT-29',
    title: 'Actual amount differs from the plan',
    base: 'B0',
    steps: [
      { op: 'rule', name: 'Electricity', kind: 'expense', from: 'Current', lines: [['Utilities', '60.00']], day: 22, estimated: true },
      { op: 'confirm', rule: 'Electricity', original: '2026-03-22', on: '2026-03-22', amount: '71.40' },
    ],
    checks: [
      { at: '2026-03-20', safeToSpend: '1040.00' },
      { at: '2026-03-22', balances: { Current: '928.60' }, flows: [{ from: '2026-03-01', to: '2026-03-31', expenses: '71.40' }], safeToSpend: '1028.60' },
    ],
  },
  {
    id: 'GT-31 (a)',
    title: 'A one-off overdue item counts, whatever its date',
    base: 'B0',
    steps: [{ op: 'plan', name: 'Car service', kind: 'expense', from: 'Current', lines: [['Household', '600.00']], date: '2026-03-05' }],
    checks: [{ at: '2026-03-20', safeToSpend: '500.00', uco: '600.00' }],
  },
  {
    id: 'GT-31 (a, skipped)',
    title: 'Skipping it gives the money back, with no ledger change',
    base: 'B0',
    steps: [
      { op: 'plan', name: 'Car service', kind: 'expense', from: 'Current', lines: [['Household', '600.00']], date: '2026-03-05' },
      { op: 'skip', rule: 'Car service', original: '2026-03-05', on: '2026-03-20' },
    ],
    checks: [{ at: '2026-03-20', safeToSpend: '1100.00', balances: { Current: '1000.00' }, netWorth: '3100.00' }],
  },
  {
    id: 'GT-31 (b)',
    title: 'Monthly rent with March unpaid: a shortfall, not zero',
    base: 'B0',
    steps: [{ op: 'rule', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '600.00']], day: 5 }],
    checks: [{ at: '2026-03-20', uco: '1200.00', safeToSpend: '-100.00' }],
  },
];

const paydayRules: Op[] = [
  { op: 'rule', name: 'Salary', kind: 'income', to: 'Current', lines: [['Salary', '2000.00']], day: 25, payday: true, start: '2026-03-20' },
  { op: 'rule', name: 'Internet', kind: 'expense', from: 'Current', lines: [['Utilities', '30.00']], day: 24, start: '2026-03-20' },
  { op: 'rule', name: 'Phone', kind: 'expense', from: 'Current', lines: [['Utilities', '20.00']], day: 25, start: '2026-03-20' },
  { op: 'rule', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '600.00']], day: 1, start: '2026-04-01' },
];
const payInternet: Op = { op: 'confirm', rule: 'Internet', original: '2026-03-24', on: '2026-03-24' };
const payPhone: Op = { op: 'confirm', rule: 'Phone', original: '2026-03-25', on: '2026-03-25' };

/** §6.7 and §7: the window, and what's due on payday (option (c), AP-02). */
const window: Scenario[] = [
  {
    id: 'GT-32 (before)',
    title: 'The window ends the day before payday',
    base: 'B0',
    steps: paydayRules,
    checks: [{ at: '2026-03-20', uco: '30.00', safeToSpend: '1070.00', windowTo: '2026-03-24', dueOnPayday: ['Phone'], perDay: '214.00' }],
  },
  {
    id: 'GT-32 (on payday)',
    title: 'On payday, before the salary, items due today count',
    base: 'B0',
    steps: [...paydayRules, payInternet],
    checks: [{ at: '2026-03-25', uco: '20.00', safeToSpend: '1050.00', windowTo: '2026-03-25', dueOnPayday: [] }],
  },
  {
    id: 'GT-32 (after)',
    title: 'Once the salary is matched, the window moves to the next one',
    base: 'B0',
    steps: [...paydayRules, payInternet, payPhone, { op: 'confirm', rule: 'Salary', original: '2026-03-25', on: '2026-03-25' }],
    checks: [{ at: '2026-03-25', uco: '630.00', safeToSpend: '2420.00', windowTo: '2026-04-24', dueOnPayday: ['Phone'] }],
  },
  {
    id: 'GT-33',
    title: 'Late payday income is ignored when setting the window',
    base: 'B0',
    steps: [...paydayRules, payInternet, payPhone, { op: 'confirm', rule: 'Salary', original: '2026-03-25', on: '2026-03-27' }],
    checks: [
      { at: '2026-03-26', balances: { Current: '950.00' }, uco: '630.00', safeToSpend: '420.00', windowTo: '2026-04-24', latePayday: ['Salary'] },
      { at: '2026-03-27', balances: { Current: '2950.00' }, safeToSpend: '2420.00', latePayday: [] },
    ],
  },
  {
    id: 'GT-34',
    title: 'A planned savings transfer counts, by default',
    base: 'B0',
    steps: [
      { op: 'plan', name: 'To savings', kind: 'transfer', from: 'Current', to: 'Savings', amount: '300.00', date: '2026-03-28' },
      { op: 'confirm', rule: 'To savings', original: '2026-03-28', on: '2026-03-28' },
    ],
    checks: [
      { at: '2026-03-20', safeToSpend: '800.00' },
      { at: '2026-03-28', balances: { Current: '700.00' }, safeToSpend: '800.00' },
    ],
  },
  {
    id: 'GT-34 (S-5 off)',
    title: 'With the setting off, it counts only once the money moves',
    base: 'B0',
    steps: [
      { op: 'setSavingsTransfers', count: false },
      { op: 'plan', name: 'To savings', kind: 'transfer', from: 'Current', to: 'Savings', amount: '300.00', date: '2026-03-28' },
      { op: 'confirm', rule: 'To savings', original: '2026-03-28', on: '2026-03-28' },
    ],
    checks: [
      { at: '2026-03-20', safeToSpend: '1100.00' },
      { at: '2026-03-28', safeToSpend: '800.00' },
    ],
  },
  {
    id: 'GT-62',
    title: 'Payday on a non-working day moves to the working day before',
    base: 'B0',
    steps: [
      { op: 'rule', name: 'Salary', kind: 'income', to: 'Current', lines: [['Salary', '2000.00']], day: 31, payday: true, start: '2026-10-01', nonWorkingDay: 'previous' },
      { op: 'rule', name: 'Internet', kind: 'expense', from: 'Current', lines: [['Utilities', '30.00']], day: 29, start: '2026-10-01' },
      { op: 'rule', name: 'Phone', kind: 'expense', from: 'Current', lines: [['Utilities', '20.00']], day: 30, start: '2026-10-01' },
      { op: 'confirm', rule: 'Internet', original: '2026-10-29', on: '2026-10-29' },
    ],
    checks: [
      { at: '2026-10-28', uco: '30.00', safeToSpend: '1070.00', windowTo: '2026-10-29', dueOnPayday: ['Phone'] },
      { at: '2026-10-30', uco: '20.00', safeToSpend: '1050.00', windowTo: '2026-10-30' },
    ],
  },
  {
    id: 'GT-62 (on the date)',
    title: 'The control case: payday stays on the Saturday',
    base: 'B0',
    steps: [
      { op: 'rule', name: 'Salary', kind: 'income', to: 'Current', lines: [['Salary', '2000.00']], day: 31, payday: true, start: '2026-10-01' },
      { op: 'rule', name: 'Internet', kind: 'expense', from: 'Current', lines: [['Utilities', '30.00']], day: 29, start: '2026-10-01' },
      { op: 'rule', name: 'Phone', kind: 'expense', from: 'Current', lines: [['Utilities', '20.00']], day: 30, start: '2026-10-01' },
    ],
    checks: [{ at: '2026-10-28', uco: '50.00', safeToSpend: '1050.00', windowTo: '2026-10-30' }],
  },
  {
    id: 'GT-62 (after the salary)',
    title: 'After the salary is matched, the next payday is a Monday: no shift',
    base: 'B0',
    steps: [
      { op: 'rule', name: 'Salary', kind: 'income', to: 'Current', lines: [['Salary', '2000.00']], day: 31, payday: true, start: '2026-10-01', nonWorkingDay: 'previous' },
      { op: 'confirm', rule: 'Salary', original: '2026-10-31', on: '2026-10-30' },
    ],
    checks: [{ at: '2026-10-30', windowTo: '2026-11-29' }],
  },
  {
    id: 'GT-67 (a)',
    title: 'A manual entry linked to the plan changes nothing',
    base: 'B0',
    steps: [
      RENT_25,
      { op: 'expense', date: '2026-03-24', account: 'Current', lines: [['Rent', '600.00']], ref: 'paid' },
      { op: 'link', rule: 'Rent', original: '2026-03-25', ref: 'paid', on: '2026-03-24' },
    ],
    checks: [
      { at: '2026-03-20', safeToSpend: '500.00' },
      { at: '2026-03-24', safeToSpend: '500.00' },
    ],
  },
  {
    id: 'GT-67 (b)',
    title: 'Kept separate, it is counted twice until someone links it',
    base: 'B0',
    steps: [RENT_25, { op: 'expense', date: '2026-03-24', account: 'Current', lines: [['Rent', '600.00']] }],
    checks: [{ at: '2026-03-24', uco: '600.00', safeToSpend: '-100.00' }],
  },
];

/** §6.4, §6.5: cards and debts in the formula. */
const cards: Scenario[] = [
  {
    id: 'GT-16 (A)',
    title: 'Reserve off: the planned repayment is what counts',
    base: 'B0',
    steps: [{ ...CARD, cardReserve: false }, { op: 'plan', name: 'Card payment', kind: 'transfer', from: 'Current', to: 'Card', amount: '300.00', date: '2026-03-25' }],
    checks: [{ at: '2026-03-20', uco: '300.00', safeToSpend: '800.00' }],
  },
  {
    id: 'GT-16 (B)',
    title: 'Reserve on: the reserve counts and the payment does not',
    base: 'B0',
    steps: [CARD, { op: 'plan', name: 'Card payment', kind: 'transfer', from: 'Current', to: 'Card', amount: '300.00', date: '2026-03-25' }],
    checks: [{ at: '2026-03-20', uco: '300.00', safeToSpend: '800.00' }],
  },
  {
    id: 'GT-16 (C)',
    title: 'Reserve on, plus a planned charge on the card',
    base: 'B0',
    steps: [CARD, { op: 'plan', name: 'Card payment', kind: 'transfer', from: 'Current', to: 'Card', amount: '300.00', date: '2026-03-25' }, { op: 'plan', name: 'Netflix', kind: 'expense', from: 'Card', lines: [['Household', '15.00']], date: '2026-04-01' }],
    checks: [{ at: '2026-03-20', uco: '315.00', safeToSpend: '785.00' }],
  },
  {
    id: 'GT-16 (C, reserve off)',
    title: 'Reserve off: a charge on the card is not counted',
    base: 'B0',
    steps: [{ ...CARD, cardReserve: false }, { op: 'plan', name: 'Card payment', kind: 'transfer', from: 'Current', to: 'Card', amount: '300.00', date: '2026-03-25' }, { op: 'plan', name: 'Netflix', kind: 'expense', from: 'Card', lines: [['Household', '15.00']], date: '2026-04-01' }],
    checks: [{ at: '2026-03-20', safeToSpend: '800.00' }],
  },
  {
    id: 'GT-20',
    title: 'A planned instalment, confirmed',
    base: 'B0',
    steps: [
      { op: 'account', name: 'Loan', type: 'loan', opening: '8000.00' },
      { op: 'rule', name: 'Instalment', kind: 'debtPayment', from: 'Current', to: 'Loan', principal: '320.00', extras: [['Interest', '80.00']], day: 25 },
      { op: 'confirm', rule: 'Instalment', original: '2026-03-25', on: '2026-03-25' },
    ],
    checks: [
      { at: '2026-03-20', safeToSpend: '700.00' },
      { at: '2026-03-25', balances: { Current: '600.00', Loan: '7680.00' }, flows: [{ from: '2026-03-01', to: '2026-03-31', expenses: '80.00' }], safeToSpend: '700.00', windowTo: '2026-04-24' },
    ],
  },
  {
    id: 'GT-63 (income)',
    title: 'Cashback as income',
    base: 'B0',
    steps: [{ op: 'income', date: '2026-03-15', account: 'Current', lines: [['Cashback', '5.00']] }],
    checks: [{ at: '2026-03-31', flows: [{ from: '2026-03-01', to: '2026-03-31', income: '5.00', expenses: '0.00', netResult: '5.00' }], netWorth: '3105.00', safeToSpend: '1105.00' }],
  },
  {
    id: 'GT-63 (reclassified)',
    title: 'The same cashback as a Shopping refund: only the split differs',
    base: 'B0',
    steps: [{ op: 'refund', date: '2026-03-15', account: 'Current', lines: [['Shopping', '5.00']] }],
    checks: [
      {
        at: '2026-03-31',
        flows: [{ from: '2026-03-01', to: '2026-03-31', income: '0.00', expenses: '-5.00', netResult: '5.00' }],
        netWorth: '3105.00',
        safeToSpend: '1105.00',
        budgets: [{ category: 'Shopping', month: '2026-03', limit: '150.00', spent: '-5.00', display: '0.0 %' }],
      },
    ],
  },
  {
    id: 'GT-63 (card credit)',
    title: 'A statement credit on a reserved card',
    base: 'B0',
    steps: [CARD, { op: 'income', date: '2026-03-15', account: 'Card', lines: [['Cashback', '5.00']] }],
    checks: [{ at: '2026-03-31', balances: { Card: '295.00' }, safeToSpend: '805.00' }],
  },
];

const allocate = (goal: string, account: string, amount: string, on = '2026-03-02'): Extract<Op, { op: 'allocate' }> => ({ op: 'allocate', goal, account, amount, on });

/** §6.11: goal money. */
const goals: Scenario[] = [
  {
    id: 'GT-48',
    title: "Allocating money doesn't create money",
    base: 'B1',
    steps: [{ op: 'goal', name: 'House', target: '20000.00' }, { op: 'goal', name: 'Emergency' }, allocate('House', 'Current', '2000.00'), allocate('Emergency', 'Savings', '1500.00')],
    checks: [{ at: '2026-03-31', balances: { Current: '3000.00', Savings: '2000.00' }, netWorth: '5100.00', backed: { House: '2000.00', Emergency: '1500.00' }, uga: '2000.00', safeToSpend: '1100.00' }],
  },
  {
    id: 'GT-49',
    title: "Allocations can't exceed the money available; dedicated accounts hold none",
    base: 'B0',
    steps: [
      { op: 'goal', name: 'Car' },
      { op: 'goal', name: 'Vacation' },
      { op: 'goal', name: 'House' },
      allocate('Car', 'Current', '800.00'),
      { ...allocate('Vacation', 'Current', '300.00'), rejected: true },
      allocate('Vacation', 'Current', '200.00'),
      { op: 'dedicate', goal: 'House', account: 'Savings' },
      { ...allocate('Vacation', 'Savings', '100.00'), rejected: true },
    ],
    checks: [{ at: '2026-03-31', safeToSpend: '100.00', progress: { House: '2000.00' } }],
  },
  {
    id: 'GT-50',
    title: 'Moving goal money out of savings leaves a shortfall, and no change to STS',
    base: 'B0',
    steps: [{ op: 'goal', name: 'Emergency' }, { op: 'goal', name: 'Vacation' }, allocate('Emergency', 'Savings', '1200.00'), allocate('Vacation', 'Savings', '800.00'), { op: 'transfer', date: '2026-03-10', from: 'Savings', to: 'Current', amount: '500.00' }],
    checks: [{ at: '2026-03-31', balances: { Savings: '1500.00' }, netWorth: '3100.00', backed: { Emergency: '900.00', Vacation: '600.00' }, uga: '500.00', safeToSpend: '1100.00' }],
  },
  {
    id: 'GT-50 (follow-up)',
    title: 'Moving the allocation with the money closes the shortfall',
    base: 'B0',
    steps: [
      { op: 'goal', name: 'Emergency' },
      { op: 'goal', name: 'Vacation' },
      allocate('Emergency', 'Savings', '1200.00'),
      allocate('Vacation', 'Savings', '800.00'),
      { op: 'transfer', date: '2026-03-10', from: 'Savings', to: 'Current', amount: '500.00' },
      { op: 'moveAllocation', goal: 'Emergency', from: 'Savings', to: 'Current', amount: '500.00', on: '2026-03-10' },
    ],
    checks: [{ at: '2026-03-31', backed: { Emergency: '1200.00', Vacation: '800.00' }, uga: '500.00', safeToSpend: '1100.00' }],
  },
  {
    id: 'GT-51',
    title: 'Spending into goal money, then releasing part of it',
    base: 'B1',
    steps: [{ op: 'goal', name: 'House' }, allocate('House', 'Current', '2000.00'), { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Household', '1500.00']] }, { op: 'release', goal: 'House', account: 'Current', amount: '500.00', on: '2026-03-20' }],
    checks: [
      { at: '2026-03-10', balances: { Current: '1500.00' }, netWorth: '3600.00', backed: { House: '1500.00' }, safeToSpend: '-400.00' },
      { at: '2026-03-20', safeToSpend: '100.00' },
    ],
  },
  {
    id: 'GT-52',
    title: 'Backed amounts share by largest remainder, ties by creation order',
    base: 'none',
    steps: [
      { op: 'account', name: 'Savings', type: 'savings', opening: '1200.00', spendable: false },
      { op: 'goal', name: 'A' },
      { op: 'goal', name: 'B' },
      { op: 'goal', name: 'C' },
      allocate('A', 'Savings', '400.00'),
      allocate('B', 'Savings', '400.00'),
      allocate('C', 'Savings', '400.00'),
      { op: 'expense', date: '2026-03-10', account: 'Savings', lines: [['Household', '199.99']] },
    ],
    checks: [{ at: '2026-03-31', balances: { Savings: '1000.01' }, backed: { A: '333.34', B: '333.34', C: '333.33' }, uga: '199.99' }],
  },
  {
    id: 'GT-53',
    title: 'Spending goal money for its purpose',
    base: 'B1',
    steps: [{ op: 'goal', name: 'Vacation' }, allocate('Vacation', 'Current', '1000.00'), { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Travel', '1000.00']] }, { op: 'release', goal: 'Vacation', account: 'Current', amount: '1000.00', on: '2026-03-10' }],
    checks: [
      { at: '2026-03-09', safeToSpend: '2100.00' },
      { at: '2026-03-10', balances: { Current: '2000.00' }, backed: { Vacation: '0.00' }, safeToSpend: '2100.00' },
    ],
  },
  {
    id: 'GT-53 (not released)',
    title: 'Without the release, the money is short',
    base: 'B1',
    steps: [{ op: 'goal', name: 'Vacation' }, allocate('Vacation', 'Current', '1000.00'), { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Travel', '1000.00']] }],
    checks: [{ at: '2026-03-10', safeToSpend: '1100.00' }],
  },
  {
    id: 'GT-54',
    title: 'A planned payment linked to a goal is counted once (R5)',
    base: 'B0',
    steps: [
      { op: 'goal', name: 'Insurance' },
      allocate('Insurance', 'Current', '300.00'),
      { op: 'plan', name: 'Annual insurance', kind: 'expense', from: 'Current', lines: [['Household', '360.00']], date: '2026-04-10', goal: 'Insurance' },
      { op: 'confirm', rule: 'Annual insurance', original: '2026-04-10', on: '2026-04-10' },
      { op: 'release', goal: 'Insurance', account: 'Current', amount: '300.00', on: '2026-04-10' },
    ],
    checks: [
      { at: '2026-03-20', uga: '300.00', uco: '60.00', safeToSpend: '740.00' },
      { at: '2026-04-10', balances: { Current: '640.00' }, uga: '0.00', uco: '0.00', safeToSpend: '740.00' },
    ],
  },
  {
    id: 'GT-54 (no link)',
    title: 'Without the link, the same money would be subtracted twice',
    base: 'B0',
    steps: [{ op: 'goal', name: 'Insurance' }, allocate('Insurance', 'Current', '300.00'), { op: 'plan', name: 'Annual insurance', kind: 'expense', from: 'Current', lines: [['Household', '360.00']], date: '2026-04-10' }],
    checks: [{ at: '2026-03-20', safeToSpend: '440.00' }],
  },
  {
    id: 'GT-55',
    title: 'An overdrawn account is a shortfall; it has nothing to allocate',
    base: 'none',
    steps: [
      { op: 'account', name: 'Current', type: 'current', opening: '-150.00' },
      { op: 'account', name: 'Cash wallet', type: 'cash', opening: '100.00' },
      { op: 'account', name: 'Savings', type: 'savings', opening: '2000.00', spendable: false },
      { op: 'account', name: 'Card', type: 'card' },
      { op: 'goal', name: 'Any' },
      { ...allocate('Any', 'Current', '10.00'), rejected: true },
    ],
    checks: [{ at: '2026-03-31', safeToSpend: '-50.00', assets: '1950.00', netWorth: '1950.00' }],
  },
  {
    id: 'GT-56',
    title: 'Irregular income is never added; the reserve is',
    base: 'B0',
    steps: [
      { op: 'setReserve', amount: '500.00' },
      { op: 'plan', name: 'Invoice', kind: 'income', to: 'Current', lines: [['Salary', '1500.00']], date: '2026-03-28' },
      { op: 'plan', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '600.00']], date: '2026-04-01' },
    ],
    checks: [{ at: '2026-03-20', safeToSpend: '0.00', windowTo: '2026-04-19', expectedIncome: ['Invoice'] }],
  },
  {
    id: 'GT-57',
    title: 'Money is exact, and the 80 % alert fires only at 80 %',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-05', account: 'Current', lines: [['Food', '0.10']] },
      { op: 'expense', date: '2026-03-05', account: 'Current', lines: [['Food', '0.20']] },
      { op: 'expense', date: '2026-03-05', account: 'Current', lines: [['Food', '0.30']] },
      { op: 'expense', date: '2026-03-06', account: 'Current', lines: [['Household', '239.99']] },
    ],
    checks: [
      {
        at: '2026-03-06',
        flows: [{ from: '2026-03-05', to: '2026-03-05', expenses: '0.60' }],
        budgets: [{ category: 'Household', month: '2026-03', limit: '300.00', spent: '239.99', display: '79.9 %', crossed: [] }],
      },
    ],
  },
  {
    id: 'GT-57 (one cent more)',
    title: 'One more cent reaches 80.0 %, and the alert fires',
    base: 'B0',
    steps: [
      { op: 'expense', date: '2026-03-06', account: 'Current', lines: [['Household', '239.99']] },
      { op: 'expense', date: '2026-03-07', account: 'Current', lines: [['Household', '0.01']] },
    ],
    checks: [{ at: '2026-03-07', budgets: [{ category: 'Household', month: '2026-03', limit: '300.00', spent: '240.00', display: '80.0 %', crossed: [80] }] }],
  },
  {
    id: 'GT-65 (a)',
    title: 'Spending into goal money, answering No',
    base: 'B0',
    steps: [{ op: 'goal', name: 'Holiday' }, allocate('Holiday', 'Current', '400.00', '2026-03-05'), { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Electronics', '800.00']] }, { ...allocate('Holiday', 'Current', '1.00', '2026-03-10'), rejected: true }],
    checks: [
      { at: '2026-03-05', safeToSpend: '700.00' },
      { at: '2026-03-10', balances: { Current: '200.00' }, uga: '400.00', backed: { Holiday: '200.00' }, flows: [{ from: '2026-03-01', to: '2026-03-31', expenses: '800.00' }], safeToSpend: '-100.00' },
    ],
  },
  {
    id: 'GT-65 (b)',
    title: 'Spending into goal money, answering Yes',
    base: 'B0',
    steps: [{ op: 'goal', name: 'Holiday' }, allocate('Holiday', 'Current', '400.00', '2026-03-05'), { op: 'expense', date: '2026-03-10', account: 'Current', lines: [['Electronics', '800.00']] }, { op: 'release', goal: 'Holiday', account: 'Current', amount: '400.00', on: '2026-03-10' }],
    checks: [{ at: '2026-03-10', balances: { Current: '200.00' }, backed: { Holiday: '0.00' }, flows: [{ from: '2026-03-01', to: '2026-03-31', expenses: '800.00' }], safeToSpend: '300.00' }],
  },
  {
    id: 'GT-66 (a)',
    title: 'Save for a bill, with the money on a spendable account',
    base: 'B0',
    steps: [
      { op: 'goal', name: 'Car insurance' },
      allocate('Car insurance', 'Current', '300.00'),
      { op: 'plan', name: 'Insurance', kind: 'expense', from: 'Current', lines: [['Household', '300.00']], date: '2026-04-20', goal: 'Car insurance' },
      { op: 'confirm', rule: 'Insurance', original: '2026-04-20', on: '2026-04-20' },
      { op: 'release', goal: 'Car insurance', account: 'Current', amount: '300.00', on: '2026-04-20' },
    ],
    checks: [
      { at: '2026-03-31', windowTo: '2026-04-30', safeToSpend: '800.00' },
      { at: '2026-04-20', balances: { Current: '700.00' }, uga: '0.00', safeToSpend: '800.00' },
    ],
  },
  {
    id: 'GT-66 (b)',
    title: 'Save for a bill, with the money on savings: an accepted dip',
    base: 'B0',
    steps: [
      { op: 'goal', name: 'Car insurance' },
      allocate('Car insurance', 'Savings', '300.00'),
      { op: 'plan', name: 'Insurance', kind: 'expense', from: 'Current', lines: [['Household', '300.00']], date: '2026-04-20', goal: 'Car insurance' },
      { op: 'confirm', rule: 'Insurance', original: '2026-04-20', on: '2026-04-20' },
      { op: 'release', goal: 'Car insurance', account: 'Savings', amount: '300.00', on: '2026-04-20' },
      { op: 'transfer', date: '2026-04-21', from: 'Savings', to: 'Current', amount: '300.00' },
    ],
    checks: [
      { at: '2026-03-31', safeToSpend: '1100.00' },
      { at: '2026-04-20', safeToSpend: '800.00' },
      { at: '2026-04-21', safeToSpend: '1100.00' },
    ],
  },
  {
    id: 'GT-66 (c)',
    title: 'Two linked payments are covered in due-date order',
    base: 'B0',
    steps: [
      { op: 'goal', name: 'Bills' },
      allocate('Bills', 'Current', '300.00'),
      { op: 'plan', name: 'First', kind: 'expense', from: 'Current', lines: [['Household', '200.00']], date: '2026-04-10', goal: 'Bills' },
      { op: 'plan', name: 'Second', kind: 'expense', from: 'Current', lines: [['Household', '200.00']], date: '2026-04-20', goal: 'Bills' },
    ],
    checks: [{ at: '2026-03-31', uco: '100.00', uga: '300.00', safeToSpend: '700.00' }],
  },
  {
    id: 'GT-69',
    title: "A payment to a reserved card isn't subtracted twice",
    base: 'B0',
    steps: [CARD, { op: 'plan', name: 'Card payment', kind: 'transfer', from: 'Current', to: 'Card', amount: '300.00', date: '2026-04-15' }],
    checks: [{ at: '2026-03-31', safeToSpend: '800.00' }],
  },
];

const octoberAccounts: Op[] = [
  { op: 'account', name: 'Current', type: 'current', opening: '500.00', date: '2026-09-30' },
  { op: 'account', name: 'Savings', type: 'savings', spendable: false, date: '2026-09-30' },
  { op: 'account', name: 'Card', type: 'card', date: '2026-09-30' },
  { op: 'account', name: 'Loan', type: 'loan', opening: '8000.00', date: '2026-09-30' },
  { op: 'rule', name: 'Salary', kind: 'income', to: 'Current', lines: [['Salary', '2000.00']], day: 1, payday: true, start: '2026-10-01' },
  { op: 'rule', name: 'Loan instalment', kind: 'debtPayment', from: 'Current', to: 'Loan', principal: '250.00', extras: [['Interest', '50.00']], day: 5, start: '2026-10-01' },
  { op: 'rule', name: 'Utilities', kind: 'expense', from: 'Current', lines: [['Utilities', '150.00']], day: 15, start: '2026-10-01', estimated: true },
  { op: 'confirm', rule: 'Salary', original: '2026-10-01', on: '2026-10-01' },
  { op: 'confirm', rule: 'Loan instalment', original: '2026-10-05', on: '2026-10-05' },
  { op: 'confirm', rule: 'Utilities', original: '2026-10-15', on: '2026-10-15', amount: '162.00' },
  { op: 'expense', date: '2026-10-10', account: 'Current', lines: [['Food', '390.00']] },
  { op: 'expense', date: '2026-10-11', account: 'Current', lines: [['Transport', '105.00']] },
  { op: 'expense', date: '2026-10-12', account: 'Current', lines: [['Entertainment', '60.00']] },
  { op: 'expense', date: '2026-10-13', account: 'Card', lines: [['Shopping', '80.00']] },
  { op: 'refund', date: '2026-10-14', account: 'Card', lines: [['Shopping', '20.00']] },
  { op: 'transfer', date: '2026-10-20', from: 'Current', to: 'Savings', amount: '300.00' },
  { op: 'goal', name: 'Emergency' },
  { op: 'goal', name: 'Vacation' },
  allocate('Emergency', 'Savings', '200.00', '2026-10-20'),
  allocate('Vacation', 'Savings', '100.00', '2026-10-20'),
];

/** §6.12: the §4 month, end to end. */
const fullMonth: Scenario[] = [
  {
    id: 'GT-61',
    title: 'A full month, with end-of-month Safe to Spend',
    base: 'none',
    steps: [
      ...octoberAccounts,
      { op: 'rule', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '600.00']], day: 3, start: '2026-10-01' },
      { op: 'confirm', rule: 'Rent', original: '2026-10-03', on: '2026-10-03' },
    ],
    checks: [
      {
        at: '2026-10-31',
        balances: { Current: '583.00', Savings: '300.00', Card: '60.00', Loan: '7750.00' },
        assets: '883.00',
        liabilities: '7810.00',
        netWorth: '-6927.00',
        flows: [{ from: '2026-10-01', to: '2026-10-31', income: '2000.00', expenses: '1427.00', netResult: '573.00', cashChange: '383.00', netWorthIdentity: true }],
        budgets: [
          { category: 'Rent', month: '2026-10', limit: '600.00', spent: '600.00', display: '100.0 %' },
          { category: 'Utilities', month: '2026-10', limit: '150.00', spent: '162.00', display: '108.0 %' },
          { category: 'Food', month: '2026-10', limit: '350.00', spent: '390.00', display: '111.4 %' },
          { category: 'Shopping', month: '2026-10', limit: '80.00', spent: '60.00', display: '75.0 %' },
        ],
        backed: { Emergency: '200.00', Vacation: '100.00' },
        uco: '60.00',
        uga: '0.00',
        safeToSpend: '523.00',
        windowTo: '2026-10-31',
      },
    ],
  },
  {
    id: 'GT-61 (b)',
    title: 'Rent due the same day as the salary',
    base: 'none',
    steps: [
      ...octoberAccounts,
      { op: 'rule', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '600.00']], day: 1, start: '2026-10-01' },
      { op: 'confirm', rule: 'Rent', original: '2026-10-01', on: '2026-10-03' },
    ],
    checks: [
      { at: '2026-10-31', uco: '60.00', safeToSpend: '523.00', dueOnPayday: ['Rent'] },
      { at: '2026-11-01', uco: '660.00', safeToSpend: '-77.00' },
    ],
  },
];

const exampleOne: Op[] = [
  { op: 'account', name: 'Current', type: 'current', opening: '1450.00' },
  { op: 'account', name: 'Cash wallet', type: 'cash', opening: '50.00' },
  { op: 'account', name: 'Savings', type: 'savings', opening: '4000.00', spendable: false },
  { op: 'account', name: 'Card', type: 'card', opening: '120.00' },
  { op: 'rule', name: 'Salary', kind: 'income', to: 'Current', lines: [['Salary', '2100.00']], day: 25, payday: true, start: '2026-03-18' },
  { op: 'rule', name: 'Phone', kind: 'expense', from: 'Current', lines: [['Utilities', '25.00']], day: 20, start: '2026-03-18' },
  { op: 'rule', name: 'Electricity', kind: 'expense', from: 'Current', lines: [['Utilities', '70.00']], day: 22, start: '2026-03-18', estimated: true },
  { op: 'rule', name: 'Rent', kind: 'expense', from: 'Current', lines: [['Rent', '300.00']], day: 25, start: '2026-03-18' },
  { op: 'goal', name: 'Holiday' },
  allocate('Holiday', 'Current', '200.00', '2026-03-02'),
];

/**
 * §7.8 Example 1, the figures in the Safe to Spend user-test prototype (Stage 2 §17.2). The late
 * and T6 cases follow from it. If one of these changes, the prototype has to change with it.
 */
const userTest: Scenario[] = [
  {
    id: '§7.8 Example 1',
    title: 'The prototype: mid-cycle, on payday before the salary, and the day after',
    base: 'none',
    steps: exampleOne,
    checks: [
      { at: '2026-03-18', uco: '215.00', uga: '200.00', safeToSpend: '1085.00', perDay: '155.00', windowTo: '2026-03-24', dueOnPayday: ['Rent'], expectedIncome: ['Salary'] },
      { at: '2026-03-25', uco: '515.00', safeToSpend: '785.00', windowTo: '2026-03-25', dueOnPayday: [] },
      { at: '2026-03-26', uco: '610.00', safeToSpend: '690.00', windowTo: '2026-04-24', latePayday: ['Salary'] },
    ],
  },
  {
    id: '§7.8 Example 1 (T6, from goal money)',
    title: 'A bill paid from holiday money, with the release: the figure stays',
    base: 'none',
    steps: [...exampleOne, { op: 'expense', date: '2026-03-18', account: 'Current', lines: [['Household', '150.00']] }, { op: 'release', goal: 'Holiday', account: 'Current', amount: '150.00', on: '2026-03-18' }],
    checks: [{ at: '2026-03-18', uga: '50.00', safeToSpend: '1085.00', backed: { Holiday: '50.00' } }],
  },
  {
    id: '§7.8 Example 1 (T6, not from goal money)',
    title: 'The same bill, answering No: the figure falls by the bill',
    base: 'none',
    steps: [...exampleOne, { op: 'expense', date: '2026-03-18', account: 'Current', lines: [['Household', '150.00']] }],
    checks: [{ at: '2026-03-18', uga: '200.00', safeToSpend: '935.00', backed: { Holiday: '200.00' } }],
  },
];

/** §6.12: GT-60, the comparison report, by exact integers. */
const comparison: Scenario[] = [
  {
    id: 'GT-60',
    title: 'September against October',
    base: 'none',
    steps: [
      { op: 'account', name: 'Current', type: 'current', opening: '10000.00', date: '2026-08-31' },
      { op: 'income', date: '2026-09-01', account: 'Current', lines: [['Salary', '2000.00']] },
      { op: 'income', date: '2026-10-01', account: 'Current', lines: [['Salary', '2000.00']] },
      { op: 'expense', date: '2026-09-01', account: 'Current', lines: [['Rent', '600.00']] },
      { op: 'expense', date: '2026-09-02', account: 'Current', lines: [['Utilities', '140.00']] },
      { op: 'expense', date: '2026-09-03', account: 'Current', lines: [['Interest', '52.00']] },
      { op: 'expense', date: '2026-09-04', account: 'Current', lines: [['Food', '330.00']] },
      { op: 'expense', date: '2026-09-05', account: 'Current', lines: [['Transport', '130.00']] },
      { op: 'expense', date: '2026-09-06', account: 'Current', lines: [['Entertainment', '150.00']] },
      { op: 'expense', date: '2026-09-07', account: 'Current', lines: [['Shopping', '98.00']] },
      { op: 'expense', date: '2026-10-01', account: 'Current', lines: [['Rent', '600.00']] },
      { op: 'expense', date: '2026-10-02', account: 'Current', lines: [['Utilities', '162.00']] },
      { op: 'expense', date: '2026-10-03', account: 'Current', lines: [['Interest', '50.00']] },
      { op: 'expense', date: '2026-10-04', account: 'Current', lines: [['Food', '390.00']] },
      { op: 'expense', date: '2026-10-05', account: 'Current', lines: [['Transport', '105.00']] },
      { op: 'expense', date: '2026-10-06', account: 'Current', lines: [['Entertainment', '60.00']] },
      { op: 'expense', date: '2026-10-07', account: 'Current', lines: [['Shopping', '60.00']] },
    ],
    checks: [
      {
        at: '2026-10-31',
        comparison: {
          a: { from: '2026-09-01', to: '2026-09-30' },
          b: { from: '2026-10-01', to: '2026-10-31' },
          lines: {
            income: ['2000.00', '2000.00', '0.00', '0.0 %'],
            expenses: ['1500.00', '1427.00', '-73.00', '−4.9 %'],
            netResult: ['500.00', '573.00', '73.00', '+14.6 %'],
            Utilities: ['140.00', '162.00', '22.00', '+15.7 %'],
            Interest: ['52.00', '50.00', '-2.00', '−3.8 %'],
            Food: ['330.00', '390.00', '60.00', '+18.2 %'],
            Transport: ['130.00', '105.00', '-25.00', '−19.2 %'],
            Entertainment: ['150.00', '60.00', '-90.00', '−60.0 %'],
            Shopping: ['98.00', '60.00', '-38.00', '−38.8 %'],
          },
        },
      },
    ],
  },
];

export const planning: Scenario[] = [...plannedVersusActual, ...window, ...cards, ...goals, ...fullMonth, ...userTest, ...comparison];
