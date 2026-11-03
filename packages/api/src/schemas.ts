/**
 * Request validation at the API boundary (Stage 2 §8.4, layer one of three). Clients send
 * intentions; there is no field for a balance, a posting or a currency (Stage 2 §9.3).
 */
import { z } from 'zod';
import { isIsoDate, MAX_ABS_CENTS } from '@fintrack/domain';

export const isoDate = z.string().refine(isIsoDate, 'must be a calendar date in YYYY-MM-DD form');
export const id = z.uuid();
export const positiveMinor = z.number().int().positive().max(MAX_ABS_CENTS);
export const signedMinor = z
  .number()
  .int()
  .min(-MAX_ABS_CENTS)
  .max(MAX_ABS_CENTS)
  .refine((value) => value !== 0, 'must not be zero');
const text = (max: number) => z.string().trim().min(1).max(max);

export const createWorkspaceBody = z.strictObject({
  name: text(100),
  currency: z.enum(['EUR', 'USD']),
  timezone: z.string().refine(isTimeZone, 'must be an IANA time zone, for example Europe/Sofia'),
});

export const accountTypes = ['current', 'savings', 'cash', 'investment', 'lent', 'other_asset', 'card', 'loan', 'other_liability'] as const;

export const createAccountBody = z.strictObject({
  name: text(100),
  type: z.enum(accountTypes),
  openingDate: isoDate,
  /** The balance for assets (may be negative, e.g. an overdraft) or the amount owed for liabilities. */
  openingAmount_minor: z.number().int().min(-MAX_ABS_CENTS).max(MAX_ABS_CENTS).default(0),
  spendable: z.boolean().optional(),
  cardReserve: z.boolean().optional(),
});

export const createCategoryBody = z.strictObject({
  name: text(100),
  kind: z.enum(['income', 'expense']),
  parentId: id.optional(),
});

const meta = {
  description: text(500).optional(),
  memo: text(1000).optional(),
};
const plainLine = z.strictObject({ categoryId: id, amount_minor: positiveMinor });
const expenseLine = plainLine.extend({ mark: z.literal('discount').optional() });
const incomeLine = plainLine.extend({ mark: z.literal('deduction').optional() });

export const createTransactionBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('expense'), date: isoDate, accountId: id, lines: z.array(expenseLine).min(1).max(50), ...meta }),
  z.strictObject({ kind: z.literal('income'), date: isoDate, accountId: id, lines: z.array(incomeLine).min(1).max(50), ...meta }),
  z.strictObject({
    kind: z.literal('refund'),
    date: isoDate,
    accountId: id,
    lines: z.array(plainLine).min(1).max(50),
    refundOfId: id.optional(),
    ...meta,
  }),
  z.strictObject({
    kind: z.literal('debt_payment'),
    date: isoDate,
    fromAccountId: id,
    liabilityAccountId: id,
    principal_minor: positiveMinor,
    extras: z.array(plainLine).max(10).optional(),
    ...meta,
  }),
  z.strictObject({
    kind: z.literal('split'),
    date: isoDate,
    lines: z.array(z.strictObject({ ledgerAccountId: id, amount_minor: signedMinor })).min(2).max(50),
    ...meta,
  }),
]);

export const createTransferBody = z.strictObject({
  date: isoDate,
  fromAccountId: id,
  toAccountId: id,
  amount_minor: positiveMinor,
  fee: z.strictObject({ categoryId: id, amount_minor: positiveMinor }).optional(),
  ...meta,
});

/** An edit sends the full new intention (Stage 2 §9.2), including a transfer's. */
export const editTransactionBody = z.discriminatedUnion('kind', [
  ...createTransactionBody.options,
  createTransferBody.extend({ kind: z.literal('transfer') }),
]);

export const emptyBody = z.strictObject({});

export const periodQuery = z.strictObject({ from: isoDate, to: isoDate }).refine((p) => p.from <= p.to, 'from must not be after to');

export const summaryQuery = z.strictObject({ at: isoDate.optional() });

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}
