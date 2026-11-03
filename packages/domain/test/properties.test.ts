/**
 * Property tests (Stage 2 §12.1): random operation sequences must preserve the ledger
 * invariants and the Safe to Spend properties P1, P2 and P4 (§7.9).
 */
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import * as build from '../src/build.ts';
import type { Transaction } from '../src/ledger.ts';
import { Ledger } from '../src/metrics.ts';
import { safeToSpend } from '../src/sts.ts';
import { checkTransaction } from '../src/validate.ts';
import { testChart, TODAY } from './fixtures.ts';

const chart = testChart();
const amount = fc.integer({ min: 1, max: 5_000_00 });
const day = fc.integer({ min: 2, max: 31 }).map((d) => `2026-03-${String(d).padStart(2, '0')}`);
const spendable = fc.constantFrom('Current', 'Cash');
const anyUserAccount = fc.constantFrom('Current', 'Cash', 'Savings', 'Card', 'Loan');

const operation = fc.oneof(
  fc.record({ kind: fc.constant('expense' as const), date: day, account: anyUserAccount, amount }),
  fc.record({ kind: fc.constant('income' as const), date: day, account: anyUserAccount, amount }),
  fc.record({ kind: fc.constant('transfer' as const), date: day, from: anyUserAccount, to: anyUserAccount, amount, fee: fc.nat({ max: 500 }) }),
  fc.record({ kind: fc.constant('refund' as const), date: day, account: anyUserAccount, amount }),
);

type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never;

let counter = 0;
function toTransaction(op: Operation): Transaction | null {
  const id = `p${++counter}`;
  switch (op.kind) {
    case 'expense':
      return build.expense({ id, date: op.date, accountId: op.account, lines: [{ categoryId: 'Food', amount: op.amount }] });
    case 'income':
      return build.income({ id, date: op.date, accountId: op.account, lines: [{ categoryId: 'Salary', amount: op.amount }] });
    case 'transfer':
      if (op.from === op.to) return null;
      return op.fee > 0
        ? build.transfer({ id, date: op.date, fromId: op.from, toId: op.to, amount: op.amount, fee: { categoryId: 'Fees', amount: op.fee } })
        : build.transfer({ id, date: op.date, fromId: op.from, toId: op.to, amount: op.amount });
    case 'refund':
      return build.refund(chart, { id, date: op.date, accountId: op.account, lines: [{ categoryId: 'Food', amount: op.amount }] });
  }
}

const openings = [
  build.openingBalance(chart, { id: 'oc', date: '2026-03-01', accountId: 'Current', amount: 100000 })!,
  build.openingBalance(chart, { id: 'ow', date: '2026-03-01', accountId: 'Cash', amount: 10000 })!,
  build.openingBalance(chart, { id: 'os', date: '2026-03-01', accountId: 'Savings', amount: 200000 })!,
  build.openingBalance(chart, { id: 'ok', date: '2026-03-01', accountId: 'Card', amount: 30000 })!,
];

describe('ledger invariants over random operation sequences', () => {
  test('every built transaction balances, and the Net Worth identity holds', () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (ops) => {
        const txs = [...openings];
        for (const op of ops) {
          const tx = toTransaction(op);
          if (!tx) continue;
          expect(checkTransaction(tx, chart, { today: TODAY })).toEqual([]);
          txs.push(tx);
        }
        const ledger = new Ledger(chart, txs);
        const march = { from: '2026-03-01', to: '2026-03-31' };
        expect(ledger.netWorthIdentity(march).holds).toBe(true);
        expect(ledger.netWorth(TODAY)).toBe(ledger.assets(TODAY) - ledger.liabilities(TODAY));
        const all = txs.flatMap((tx) => tx.postings).reduce((sum, p) => sum + p.amount, 0);
        expect(all).toBe(0);
      }),
    );
  });

  test('voided and trashed transactions never count (LR-09)', () => {
    fc.assert(
      fc.property(fc.array(operation, { minLength: 1, maxLength: 20 }), (ops) => {
        const txs = ops.map(toTransaction).filter((tx): tx is Transaction => tx !== null);
        const hidden = txs.map((tx, index) => ({ ...tx, status: index % 2 === 0 ? 'voided' : 'trashed' }) as Transaction);
        const ledger = new Ledger(chart, [...openings, ...hidden]);
        expect(ledger.netWorth(TODAY)).toBe(new Ledger(chart, openings).netWorth(TODAY));
      }),
    );
  });
});

describe('Safe to Spend properties (§7.9)', () => {
  const stsOf = (txs: Transaction[]) => safeToSpend({ ledger: new Ledger(chart, txs), today: TODAY }).value;

  test('P1: an expense of X from a spendable account lowers STS by exactly X', () => {
    fc.assert(
      fc.property(spendable, amount, (account, value) => {
        const before = stsOf(openings);
        const after = stsOf([...openings, build.expense({ id: 'x', date: '2026-03-10', accountId: account, lines: [{ categoryId: 'Food', amount: value }] })]);
        expect(before - after).toBe(value);
      }),
    );
  });

  test('P2: a transfer between spendable accounts never changes STS', () => {
    fc.assert(
      fc.property(amount, fc.boolean(), (value, direction) => {
        const [fromId, toId] = direction ? ['Current', 'Cash'] : ['Cash', 'Current'];
        const after = stsOf([...openings, build.transfer({ id: 'x', date: '2026-03-10', fromId, toId, amount: value })]);
        expect(after).toBe(stsOf(openings));
      }),
    );
  });

  test('P4: with the card reserve on, a card purchase lowers STS by X and repaying it changes nothing', () => {
    fc.assert(
      fc.property(amount, (value) => {
        const purchase = build.expense({ id: 'buy', date: '2026-03-10', accountId: 'Card', lines: [{ categoryId: 'Food', amount: value }] });
        const repay = build.transfer({ id: 'pay', date: '2026-03-20', fromId: 'Current', toId: 'Card', amount: value });
        const base = stsOf(openings);
        expect(base - stsOf([...openings, purchase])).toBe(value);
        expect(stsOf([...openings, purchase, repay])).toBe(stsOf([...openings, purchase]));
      }),
    );
  });
});
