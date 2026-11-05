/**
 * Request validation at the API boundary (Stage 2 §8.4, layer one of three). Clients send
 * intentions; there is no field for a balance, a posting or a currency (Stage 2 §9.3).
 */
import { z } from 'zod';
import { IMPORT_DATE_FORMATS, IMPORT_ENCODINGS, isIsoDate, MAX_ABS_CENTS } from '@fintrack/domain';

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

export const updateAccountBody = z.strictObject({
  name: text(100).optional(),
  type: z.enum(accountTypes).optional(),
  spendable: z.boolean().optional(),
  cardReserve: z.boolean().optional(),
  institution: z.string().trim().max(100).nullable().optional(),
  creditLimit_minor: z.number().int().min(0).max(MAX_ABS_CENTS).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  loanPrincipal_minor: z.number().int().min(0).max(MAX_ABS_CENTS).nullable().optional(),
  loanRate_bp: z.number().int().min(0).max(100000).nullable().optional(),
  loanInstallment_minor: z.number().int().min(0).max(MAX_ABS_CENTS).nullable().optional(),
  loanTerm_months: z.number().int().min(1).max(1200).nullable().optional(),
});

export const openingBody = z
  .strictObject({
    openingDate: isoDate.optional(),
    openingAmount_minor: z.number().int().min(-MAX_ABS_CENTS).max(MAX_ABS_CENTS).optional(),
  })
  .refine((body) => body.openingDate !== undefined || body.openingAmount_minor !== undefined, 'Nothing to change');

export const orderBody = z.strictObject({ ids: z.array(id).min(1).max(1000) });

export const updateCategoryBody = z.strictObject({ name: text(100).optional(), parentId: id.nullable().optional() });

export const updateWorkspaceBody = z.strictObject({
  name: text(100).optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').optional(),
  protectedReserve_minor: z.number().int().min(0).max(MAX_ABS_CENTS).optional(),
  stsCountSavingsTransfers: z.boolean().optional(),
  currency: z.enum(['EUR', 'USD']).optional(),
});

/** The only consent a user changes after sign-up (Annex L item 6). */
export const consentBody = z.strictObject({ document: z.literal('marketing'), accepted: z.boolean() });

export const createCategoryBody = z.strictObject({
  name: text(100),
  kind: z.enum(['income', 'expense']),
  parentId: id.optional(),
});

const meta = {
  description: text(500).optional(),
  memo: text(1000).optional(),
  /** A name, not an ID: a new name creates the payee (BR-05.6). */
  payee: text(100).optional(),
  /** G-P4: this spending comes out of a goal's money, atomically (AC-09.8). */
  useGoalMoney: z.strictObject({ goalId: id, amount_minor: positiveMinor.optional() }).optional(),
  /** BR-08.5: this entry is that planned item. */
  linkOccurrenceId: id.optional(),
  /** BR-07.13: bought on an instalment plan. The full price still counts now (D-15). */
  instalment: z.boolean().optional(),
};
const plainLine = z.strictObject({ categoryId: id, amount_minor: positiveMinor, memo: text(500).optional() });
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
    /** BR-04.7: a refund above the original needs this explicit confirmation. */
    confirmExceedsOriginal: z.boolean().optional(),
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
    lines: z.array(z.strictObject({ ledgerAccountId: id, amount_minor: signedMinor, memo: text(500).optional() })).min(2).max(50),
    ...meta,
  }),
]);

export const createTransferBody = z.strictObject({
  date: isoDate,
  fromAccountId: id,
  toAccountId: id,
  amount_minor: positiveMinor,
  fee: z.strictObject({ categoryId: id, amount_minor: positiveMinor }).optional(),
  /** G-T2: the goal money that would be left short moves with the transfer, as one step. */
  moveAllocations: z.boolean().optional(),
  ...meta,
});

/** An edit sends the full new intention (Stage 2 §9.2), including a transfer's. */
export const editTransactionBody = z.discriminatedUnion('kind', [
  ...createTransactionBody.options,
  createTransferBody.extend({ kind: z.literal('transfer') }),
]);

export const emptyBody = z.strictObject({});

const signedOrZeroMinor = z.number().int().min(-MAX_ABS_CENTS).max(MAX_ABS_CENTS);

/** The statement and the items the user ticked (FR-18). The server works out every figure. */
export const reconciliationPreviewBody = z.strictObject({
  accountId: id,
  statementDate: isoDate,
  /** As the statement shows it: the balance for assets, the amount owed for cards and loans. */
  statementBalance_minor: signedOrZeroMinor,
  transactionIds: z.array(id).max(5000),
});

export const reconciliationBody = reconciliationPreviewBody.extend({
  /** How to close a remaining difference: ADJ by default, or a category the user chose (E-36, E-37). */
  adjustment: z.strictObject({ categoryId: id.optional() }).optional(),
});

/** Quick balance update for cash, investments and other assets (FR-18). */
export const balanceUpdateBody = z.strictObject({
  date: isoDate,
  actual_minor: signedOrZeroMinor,
  /** "I spent it": the difference becomes spending in this category (E-37). */
  categoryId: id.optional(),
});

export const mergeCategoryBody = z.strictObject({ intoId: id });

/** The password is used once to encrypt the file and is never stored or logged. */
export const exportBody = z.strictObject({ password: z.string().min(12).max(128).optional() });

const column = z.number().int().min(0).max(500);
const importMapping = z.strictObject({
  date: column,
  amount: column.optional(),
  debit: column.optional(),
  credit: column.optional(),
  description: column.optional(),
  counterparty: column.optional(),
  reference: column.optional(),
  currency: column.optional(),
});
const importFormat = {
  encoding: z.enum(IMPORT_ENCODINGS),
  delimiter: z.enum([';', ',', '\t', '|']),
  decimalSeparator: z.enum(['.', ',']),
  dateFormat: z.enum(IMPORT_DATE_FORMATS),
  headerRow: z.number().int().min(0).max(500).nullable(),
};

/** How to read a file (FR-16 steps 2 and 3). */
export const importSettings = z.strictObject({
  ...importFormat,
  mapping: importMapping.refine((m) => m.amount !== undefined || m.debit !== undefined || m.credit !== undefined, 'map an amount, or debit and credit columns'),
});

/** The choices the user has changed so far; the rest comes from detection. */
export const previewSettings = z.strictObject({
  encoding: importFormat.encoding.optional(),
  delimiter: importFormat.delimiter.optional(),
  decimalSeparator: importFormat.decimalSeparator.optional(),
  dateFormat: importFormat.dateFormat.optional(),
  headerRow: importFormat.headerRow.optional(),
  mapping: importMapping.partial().optional(),
});

export const importDecisionsBody = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        rowId: id,
        decision: z.enum(['import', 'skip', 'link', 'transfer']).optional(),
        categoryId: id.nullable().optional(),
        /** The planned item this row is (BR-16.10). */
        occurrenceId: id.nullable().optional(),
        counterAccountId: id.nullable().optional(),
      }),
    )
    .min(1)
    .max(10_000),
});

export const importConfirmBody = z.strictObject({ confirmCurrency: z.boolean().optional() });
export const importUndoBody = z.strictObject({ confirmEdited: z.boolean().optional() });

export const auditQuery = z.strictObject({ before: id.optional() });

export const reconciliationsQuery = z.strictObject({ accountId: id.optional() });

const minorQuery = z.coerce.number().int().min(0).max(MAX_ABS_CENTS);

/** Search and filter (BR-04.5), each against an allowlist. Tags join with the tags feature (Should). */
export const transactionsQuery = z
  .strictObject({
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().max(100).optional(),
    accountId: id.optional(),
    categoryId: id.optional(),
    payeeId: id.optional(),
    kind: z.enum(['expense', 'income', 'transfer', 'refund', 'debt_payment', 'split', 'opening_balance', 'adjustment', 'valuation']).optional(),
    origin: z.enum(['manual', 'import', 'occurrence', 'system']).optional(),
    reconciled: z.enum(['true', 'false']).optional(),
    minAmount_minor: minorQuery.optional(),
    maxAmount_minor: minorQuery.optional(),
    cursor: z.string().max(60).regex(/^\d{4}-\d{2}-\d{2}_[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(1000),
  })
  .refine((p) => !p.from || !p.to || p.from <= p.to, 'from must not be after to');

const ruleLine = z.strictObject({ ledgerAccountId: id, amount_minor: positiveMinor });
const optionalMinor = z.number().int().min(0).max(MAX_ABS_CENTS);

const ruleFields = {
  name: text(100),
  kind: z.enum(['expense', 'income', 'transfer', 'debt_payment']),
  amountType: z.enum(['fixed', 'estimated']).optional(),
  accountId: id,
  /** Categories; the other account for a transfer; the liability, then categories, for a debt payment. */
  lines: z.array(ruleLine).min(1).max(50),
  frequency: z.enum(['once', 'weekly', 'every_n_weeks', 'monthly_day', 'monthly_last', 'every_n_months', 'yearly']),
  interval: z.number().int().min(1).max(60).optional(),
  anchorDay: z.number().int().min(1).max(31).optional(),
  startDate: isoDate,
  endDate: isoDate.optional(),
  maxCount: z.number().int().min(1).max(1000).optional(),
  nonWorkingDay: z.enum(['on_date', 'previous', 'next']).optional(),
  isPayday: z.boolean().optional(),
  payer: text(100).optional(),
  expectedMin_minor: optionalMinor.optional(),
  expectedMax_minor: optionalMinor.optional(),
  reminderDays: z.number().int().min(0).max(60).optional(),
  goalId: id.optional(),
};

export const createRuleBody = z.strictObject(ruleFields);

export const updateRuleBody = z.strictObject({
  name: ruleFields.name.optional(),
  kind: ruleFields.kind.optional(),
  amountType: ruleFields.amountType,
  accountId: id.optional(),
  lines: ruleFields.lines.optional(),
  frequency: ruleFields.frequency.optional(),
  interval: ruleFields.interval,
  anchorDay: z.number().int().min(1).max(31).nullable().optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
  maxCount: z.number().int().min(1).max(1000).nullable().optional(),
  nonWorkingDay: ruleFields.nonWorkingDay,
  isPayday: ruleFields.isPayday,
  payer: text(100).nullable().optional(),
  expectedMin_minor: optionalMinor.nullable().optional(),
  expectedMax_minor: optionalMinor.nullable().optional(),
  reminderDays: ruleFields.reminderDays,
  goalId: id.nullable().optional(),
  /** BR-08.6: the date from which the change applies. Today by default. */
  effectiveFrom: isoDate.optional(),
});

export const endRuleBody = z.strictObject({ date: isoDate.optional() });

export const occurrencesQuery = z.strictObject({
  from: isoDate.optional(),
  to: isoDate.optional(),
  includeClosed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

export const confirmOccurrenceBody = z.strictObject({
  date: isoDate.optional(),
  amount_minor: positiveMinor.optional(),
  lines: ruleFields.lines.optional(),
  accountId: id.optional(),
  useGoalMoney: z.boolean().optional(),
});

export const linkOccurrenceBody = z.strictObject({ transactionId: id, useGoalMoney: z.boolean().optional() });

export const editOccurrenceBody = z.strictObject({ amount_minor: positiveMinor.optional(), dueDate: isoDate.optional(), goalId: id.nullable().optional() });

export const createGoalBody = z.strictObject({
  name: text(100),
  funding: z.enum(['dedicated', 'virtual']),
  target_minor: positiveMinor.optional(),
  targetDate: isoDate.optional(),
  monthly_minor: optionalMinor.optional(),
  accountIds: z.array(id).max(20).optional(),
});

export const updateGoalBody = z.strictObject({
  name: text(100).optional(),
  target_minor: positiveMinor.nullable().optional(),
  targetDate: isoDate.nullable().optional(),
  monthly_minor: optionalMinor.nullable().optional(),
});

export const allocationBody = z
  .strictObject({
    operation: z.enum(['allocate', 'decrease', 'release', 'move', 'use']),
    accountId: id,
    amount_minor: positiveMinor.optional(),
    toGoalId: id.optional(),
    toAccountId: id.optional(),
    transactionId: id.optional(),
    reason: text(200).optional(),
  })
  .refine((body) => ['release', 'use'].includes(body.operation) || body.amount_minor !== undefined, 'Enter an amount');

export const linkPaymentBody = z
  .strictObject({ occurrenceId: id.optional(), ruleId: id.optional(), unlink: z.boolean().optional() })
  .refine((body) => Boolean(body.occurrenceId) !== Boolean(body.ruleId), 'Name one planned item or one rule');

export const goalAccountBody = z.strictObject({ accountId: id });
export const goalUnlinkBody = z.strictObject({ accountId: id, spendable: z.boolean() });
export const goalConvertBody = z.strictObject({ to: z.enum(['virtual', 'dedicated']), accountId: id.optional() });

const monthText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month in YYYY-MM form');
export const budgetsQuery = z.strictObject({ month: monthText });
export const budgetMonth = monthText;
export const budgetBody = z.strictObject({
  limit_minor: optionalMinor.nullable(),
  thresholds: z.array(z.number().int().min(1).max(200)).min(1).max(3).optional(),
  applyForward: z.boolean().optional(),
});

export const debtsQuery = z.strictObject({ from: isoDate, to: isoDate }).refine((p) => p.from <= p.to, 'from must not be after to');
export const projectionQuery = z.strictObject({ days: z.enum(['30', '60', '90']).default('30').transform(Number) });

export const updatePayeeBody = z.strictObject({ name: text(100).optional(), defaultCategoryId: id.nullable().optional() });
export const mergePayeeBody = z.strictObject({ intoId: id });

export const summaryQuery = z.strictObject({ at: isoDate.optional() });

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}
