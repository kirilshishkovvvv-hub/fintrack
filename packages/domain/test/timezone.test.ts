/** GT-58: month boundaries and time zone (A-1, A-2, A-8). Dates belong to the workspace's zone, never to the server's. */
import { describe, expect, test } from 'vitest';
import { build, Chart, Ledger, todayIn, validateTransaction } from '../src/index.ts';

const sofia = (iso: string) => todayIn('Europe/Sofia', new Date(iso));

function ledgerWith(date: string) {
  const chart = new Chart();
  chart.add({ id: 'OBE', kind: 'equity', name: 'OBE', systemCode: 'OBE' });
  chart.add({ id: 'current', kind: 'asset', name: 'Current', account: { class: 'cash', type: 'current', spendable: true, cardReserve: false, openingDate: '2026-03-01' } });
  chart.add({ id: 'food', kind: 'expense', name: 'Food', category: {} });
  const tx = build.expense({ id: 't', date, accountId: 'current', lines: [{ categoryId: 'food', amount: 1000 }] });
  return { chart, tx, ledger: new Ledger(chart, [tx]) };
}

describe('GT-58', () => {
  test('31 Mar 23:30 local (20:30 UTC, summer time) is still 31 Mar, and counts in March', () => {
    const today = sofia('2026-03-31T20:30:00Z');
    expect(today).toBe('2026-03-31');
    const { ledger } = ledgerWith(today);
    expect(ledger.expenses({ from: '2026-03-01', to: '2026-03-31' })).toBe(1000);
    expect(ledger.expenses({ from: '2026-04-01', to: '2026-04-30' })).toBe(0);
  });

  test('1 Apr 00:30 local (31 Mar 21:30 UTC) is already 1 Apr, and counts in April', () => {
    const today = sofia('2026-03-31T21:30:00Z');
    expect(today).toBe('2026-04-01');
    const { ledger } = ledgerWith(today);
    expect(ledger.expenses({ from: '2026-04-01', to: '2026-04-30' })).toBe(1000);
    expect(ledger.expenses({ from: '2026-03-01', to: '2026-03-31' })).toBe(0);
  });

  test('at 31 Mar 23:30 local, an entry dated 1 Apr is a future date, and is refused', () => {
    const today = sofia('2026-03-31T20:30:00Z');
    const { chart, tx } = ledgerWith('2026-04-01');
    expect(() => validateTransaction(tx, chart, { today })).toThrow();
    const allowed = ledgerWith('2026-03-31');
    expect(() => validateTransaction(allowed.tx, allowed.chart, { today })).not.toThrow();
  });

  test('the same instant is a different day in another zone', () => {
    expect(todayIn('America/New_York', new Date('2026-03-31T21:30:00Z'))).toBe('2026-03-31');
    expect(sofia('2026-03-31T21:30:00Z')).toBe('2026-04-01');
  });
});
