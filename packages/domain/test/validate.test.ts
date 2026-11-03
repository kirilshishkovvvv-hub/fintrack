import { describe, expect, test } from 'vitest';
import * as build from '../src/build.ts';
import type { Transaction } from '../src/ledger.ts';
import { checkTransaction, LedgerError, validateTransaction } from '../src/validate.ts';
import { testChart, TODAY } from './fixtures.ts';

const chart = testChart();
const rulesOf = (tx: Transaction) => checkTransaction(tx, chart, { today: TODAY }).map((v) => v.rule);
const tx = (kind: Transaction['kind'], postings: Transaction['postings'], date = '2026-03-10'): Transaction => ({
  id: 't',
  date,
  kind,
  status: 'posted',
  postings,
});

describe('valid transactions built from intentions pass every rule', () => {
  const valid: Transaction[] = [
    build.openingBalance(chart, { id: 'o1', date: '2026-03-01', accountId: 'Current', amount: 100000 })!,
    build.openingBalance(chart, { id: 'o2', date: '2026-03-01', accountId: 'Card', amount: 30000 })!,
    build.expense({ id: 'e', date: '2026-03-10', accountId: 'Current', lines: [{ categoryId: 'Food', amount: 4560 }] }),
    build.expense({
      id: 'e2',
      date: '2026-03-10',
      accountId: 'Current',
      lines: [
        { categoryId: 'Food', amount: 5000 },
        { categoryId: 'Food', amount: 500, mark: 'discount' },
      ],
    }),
    build.income({
      id: 'i',
      date: '2026-03-10',
      accountId: 'Current',
      lines: [
        { categoryId: 'Salary', amount: 200000 },
        { categoryId: 'Fees', amount: 3000, mark: 'deduction' },
      ],
    }),
    build.transfer({ id: 't', date: '2026-03-10', fromId: 'Current', toId: 'Savings', amount: 50000, fee: { categoryId: 'Fees', amount: 150 } }),
    build.refund(chart, { id: 'r', date: '2026-03-10', accountId: 'Card', lines: [{ categoryId: 'Food', amount: 2000 }] }),
    build.refund(chart, { id: 'r2', date: '2026-03-10', accountId: 'Current', lines: [{ categoryId: 'Salary', amount: 15000 }] }),
    build.debtPayment({
      id: 'd',
      date: '2026-03-10',
      fromId: 'Current',
      liabilityId: 'Loan',
      principal: 32000,
      extras: [{ categoryId: 'Fees', amount: 8000 }],
    }),
    build.adjustment(chart, { id: 'a', date: '2026-03-10', accountId: 'Current', delta: -800 }),
    build.adjustment(chart, { id: 'a2', date: '2026-03-10', accountId: 'Cash', delta: -1500, counterId: 'Food' }),
  ];
  for (const transaction of valid) {
    test(`${transaction.kind} ${transaction.id}`, () => {
      expect(checkTransaction(transaction, chart, { today: TODAY })).toEqual([]);
    });
  }

  test('a zero opening balance needs no transaction', () => {
    expect(build.openingBalance(chart, { id: 'z', date: '2026-03-01', accountId: 'Current', amount: 0 })).toBeNull();
  });
});

describe('each ledger rule rejects what it forbids', () => {
  test('LR-01: postings must sum to zero', () => {
    expect(rulesOf(tx('expense', [{ ledgerAccountId: 'Current', amount: -100 }, { ledgerAccountId: 'Food', amount: 99 }]))).toContain('LR-01');
  });

  test('LR-02: at least two postings, none zero, at least one user account', () => {
    expect(rulesOf(tx('expense', [{ ledgerAccountId: 'Food', amount: 0 }]))).toContain('LR-02');
    expect(rulesOf(tx('split', [{ ledgerAccountId: 'Food', amount: 100 }, { ledgerAccountId: 'Salary', amount: -100 }]))).toContain('LR-02');
  });

  test('LR-04: no future dates, and nothing before an account was opened', () => {
    const future = build.expense({ id: 'f', date: '2026-04-01', accountId: 'Current', lines: [{ categoryId: 'Food', amount: 100 }] });
    expect(rulesOf(future)).toContain('LR-04');
    const early = build.expense({ id: 'e', date: '2026-02-28', accountId: 'Current', lines: [{ categoryId: 'Food', amount: 100 }] });
    expect(rulesOf(early)).toContain('LR-04');
    expect(rulesOf(tx('expense', [{ ledgerAccountId: 'Current', amount: -1 }, { ledgerAccountId: 'Food', amount: 1 }], '2026-02-30'))).toContain('LR-04');
  });

  test('LR-05: equity is reachable only through its own system kind', () => {
    const viaExpense = tx('expense', [
      { ledgerAccountId: 'Current', amount: 100 },
      { ledgerAccountId: 'OBE', amount: -100 },
    ]);
    expect(rulesOf(viaExpense)).toContain('LR-05');
    const wrongEquity = tx('opening_balance', [
      { ledgerAccountId: 'Current', amount: 100 },
      { ledgerAccountId: 'ADJ', amount: -100 },
    ]);
    expect(rulesOf(wrongEquity)).toContain('LR-05');
  });

  test('LR-06: a transfer cannot carry an income line', () => {
    const withIncome = tx('transfer', [
      { ledgerAccountId: 'Current', amount: -200 },
      { ledgerAccountId: 'Savings', amount: 300 },
      { ledgerAccountId: 'Salary', amount: -100 },
    ]);
    expect(rulesOf(withIncome)).toContain('LR-06');
  });

  test('LR-14: archived accounts and categories receive no postings', () => {
    expect(rulesOf(build.expense({ id: 'x', date: '2026-03-10', accountId: 'Closed', lines: [{ categoryId: 'Food', amount: 100 }] }))).toContain('LR-14');
    expect(rulesOf(build.expense({ id: 'y', date: '2026-03-10', accountId: 'Current', lines: [{ categoryId: 'Old category', amount: 100 }] }))).toContain('LR-14');
  });

  test('LR-15: an unmarked reversing line is a sign error outside refunds', () => {
    const negativeExpense = tx('expense', [
      { ledgerAccountId: 'Current', amount: 100 },
      { ledgerAccountId: 'Food', amount: -100 },
    ]);
    expect(rulesOf(negativeExpense)).toContain('LR-15');
    const forwardRefund = tx('refund', [
      { ledgerAccountId: 'Current', amount: -100 },
      { ledgerAccountId: 'Food', amount: 100 },
    ]);
    expect(rulesOf(forwardRefund)).toContain('LR-15');
  });

  test('LR-18: valuation only on investment and other-asset accounts', () => {
    const onCurrent = tx('valuation', [
      { ledgerAccountId: 'Current', amount: 100 },
      { ledgerAccountId: 'VAL', amount: -100 },
    ]);
    expect(rulesOf(onCurrent)).toContain('LR-18');
    const onBroker = tx('valuation', [
      { ledgerAccountId: 'Broker', amount: 100 },
      { ledgerAccountId: 'VAL', amount: -100 },
    ]);
    expect(rulesOf(onBroker)).toEqual([]);
  });

  test('§5.4: a transfer needs two different accounts in opposite directions', () => {
    const same = tx('transfer', [
      { ledgerAccountId: 'Current', amount: -100 },
      { ledgerAccountId: 'Current', amount: 100 },
    ]);
    expect(rulesOf(same)).toContain('§5.4');
  });

  test('unknown ledger accounts are rejected (BR-02.3)', () => {
    expect(rulesOf(tx('expense', [{ ledgerAccountId: 'Current', amount: -1 }, { ledgerAccountId: 'Other workspace', amount: 1 }]))).toContain('BR-02.3');
  });

  test('validateTransaction throws a LedgerError listing the violations', () => {
    expect(() =>
      validateTransaction(tx('expense', [{ ledgerAccountId: 'Current', amount: -1 }, { ledgerAccountId: 'Food', amount: 2 }]), chart, { today: TODAY }),
    ).toThrow(LedgerError);
  });
});
