import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { allocateByWeights, formatAmount, MoneyError, parseAmount, splitEqually } from '../src/money.ts';

describe('parseAmount and formatAmount', () => {
  test('parses plain decimals into cents', () => {
    expect(parseAmount('1234.56')).toBe(123456);
    expect(parseAmount('12')).toBe(1200);
    expect(parseAmount('0.5')).toBe(50);
    expect(parseAmount('-45.60')).toBe(-4560);
  });

  test('rejects more than two decimals instead of rounding (§10.2)', () => {
    expect(() => parseAmount('1.005')).toThrow(MoneyError);
  });

  test('rejects malformed input and amounts beyond the GAP-3 limit', () => {
    for (const bad of ['', 'abc', '1,50', '1.2.3', '+5', '12345678901.00']) {
      expect(() => parseAmount(bad), bad).toThrow(MoneyError);
    }
    expect(parseAmount('9999999999.99')).toBe(999_999_999_999);
  });

  test('formats cents with two decimals', () => {
    expect(formatAmount(123456)).toBe('1234.56');
    expect(formatAmount(-5)).toBe('-0.05');
    expect(formatAmount(0)).toBe('0.00');
  });

  test('round-trips every amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: -999_999_999_999, max: 999_999_999_999 }), (value) => {
        expect(parseAmount(formatAmount(value))).toBe(value);
      }),
    );
  });
});

describe('GT-05 · Percentage-split rounding', () => {
  test('(a) 100.00 split three ways equally gives 33.34 / 33.33 / 33.33', () => {
    expect(splitEqually(10000, 3)).toEqual([3334, 3333, 3333]);
  });

  test('(b) 10.00 split 1/3 and 2/3 gives 3.33 / 6.67', () => {
    expect(allocateByWeights(1000, [1, 2])).toEqual([333, 667]);
  });

  test('(c) 0.01 split 50/50 is rejected because a line would be zero (AM-5)', () => {
    expect(() => allocateByWeights(1, [50, 50])).toThrow(MoneyError);
  });

  test('lines always sum exactly to the total and stay within one cent of the exact share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999_999_999 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (amount, weights, negative) => {
          const total = negative ? -amount : amount;
          let lines: number[];
          try {
            lines = allocateByWeights(total, weights);
          } catch (error) {
            expect(error).toBeInstanceOf(MoneyError);
            return;
          }
          expect(lines.reduce((sum, line) => sum + line, 0)).toBe(total);
          const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
          lines.forEach((line, index) => {
            const exact = (Math.abs(total) * weights[index]!) / weightSum;
            expect(Math.abs(Math.abs(line) - exact)).toBeLessThan(1);
          });
        },
      ),
    );
  });
});
