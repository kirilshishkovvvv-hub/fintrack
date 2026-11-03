/**
 * Money in integer minor units (cents). Spec: LR-17, NFR-02, §10.
 * No floating point is ever used for an authoritative amount.
 */
export type Cents = number;

/** GAP-3: per-posting limit, just under 10 billion in major units. */
export const MAX_ABS_CENTS = 999_999_999_999;

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Not a whole number of cents: ${value}`);
  }
  if (Math.abs(value) > MAX_ABS_CENTS) {
    throw new MoneyError(`Amount out of range: ${value}`);
  }
  return value;
}

/**
 * Parses a plain decimal string ("1234.56", "-0.5", "12") into cents.
 * More than two decimals is rejected, never rounded (§10.2).
 * Locale formats ("1 234,56") are normalized by the input layer before this point.
 */
export function parseAmount(text: string): Cents {
  const match = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) {
    throw new MoneyError(`Invalid amount: "${text}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents(sign ? -value : value);
}

/** Formats cents as a plain decimal string with a dot, e.g. -1234.5 -> "-1234.50". For tests and exports. */
export function formatAmount(value: Cents): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return cents(total);
}

/**
 * Splits `total` across lines in proportion to positive integer `weights`, using the
 * largest-remainder method (§10.2). Leftover cents go to the largest remainders;
 * ties go to the earlier line. The result always sums exactly to `total`.
 *
 * Throws if any line would be zero (AM-5 / LR-02), e.g. 0.01 split 50/50.
 */
export function allocateByWeights(total: Cents, weights: readonly number[]): Cents[] {
  cents(total);
  if (weights.length === 0) {
    throw new MoneyError('At least one weight is required');
  }
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight <= 0) {
      throw new MoneyError(`Weights must be positive whole numbers: ${weight}`);
    }
  }

  const sign = total < 0 ? -1n : 1n;
  const absTotal = BigInt(Math.abs(total));
  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);

  const shares = weights.map((weight, index) => {
    const product = absTotal * BigInt(weight);
    return { index, floor: product / weightSum, remainder: product % weightSum };
  });

  let leftover = absTotal - shares.reduce((sum, share) => sum + share.floor, 0n);
  const order = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of order) {
    if (leftover === 0n) break;
    share.floor += 1n;
    leftover -= 1n;
  }

  const result = shares.map((share) => Number(share.floor * sign));
  if (result.some((value) => value === 0)) {
    throw new MoneyError('Every split line must be non-zero');
  }
  return result;
}

/** Equal split into `parts` lines (largest remainder, earlier lines get leftover cents). */
export function splitEqually(total: Cents, parts: number): Cents[] {
  return allocateByWeights(total, Array.from({ length: parts }, () => 1));
}
