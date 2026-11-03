/**
 * Builders turn a user's intention ("an expense of 12.50 from Current to Food")
 * into balanced postings (Stage 2 §9.3). Clients never send postings directly.
 * Every builder returns an unvalidated transaction; call validateTransaction before saving.
 */
import type { IsoDate } from './dates.ts';
import type { Chart, LineMark, Posting, Transaction } from './ledger.ts';
import { cents, sumCents, type Cents } from './money.ts';

export interface CategoryLine {
  categoryId: string;
  /** Positive cents. */
  amount: Cents;
  mark?: LineMark;
}

interface Base {
  id: string;
  date: IsoDate;
}

function transaction(base: Base, kind: Transaction['kind'], postings: Posting[], refundOfId?: string): Transaction {
  const tx: Transaction = { id: base.id, date: base.date, kind, status: 'posted', postings };
  if (refundOfId !== undefined) tx.refundOfId = refundOfId;
  return tx;
}

function posting(ledgerAccountId: string, amount: Cents, mark?: LineMark): Posting {
  const result: Posting = { ledgerAccountId, amount: cents(amount) };
  if (mark !== undefined) result.mark = mark;
  return result;
}

/**
 * Opening balance against OBE (E-01, E-02). For an asset, `amount` is the balance
 * (it may be negative, e.g. an overdraft). For a liability, `amount` is the amount owed.
 * Returns null for a zero opening balance: no transaction is needed.
 */
export function openingBalance(
  chart: Chart,
  base: Base & { accountId: string; amount: Cents },
): Transaction | null {
  if (base.amount === 0) return null;
  const account = chart.get(base.accountId);
  const signed = account.kind === 'liability' ? -base.amount : base.amount;
  return transaction(base, 'opening_balance', [
    posting(account.id, signed),
    posting(chart.system('OBE').id, -signed),
  ]);
}

/** An expense, optionally split across categories, with optional marked discount lines (E-05 to E-07). */
export function expense(base: Base & { accountId: string; lines: CategoryLine[] }): Transaction {
  const categoryPostings = base.lines.map((line) =>
    posting(line.categoryId, line.mark === 'discount' ? -line.amount : line.amount, line.mark),
  );
  const total = sumCents(categoryPostings.map((p) => p.amount));
  return transaction(base, 'expense', [posting(base.accountId, -total), ...categoryPostings]);
}

/** Income, optionally with marked deduction lines that are expenses (E-04). */
export function income(base: Base & { accountId: string; lines: CategoryLine[] }): Transaction {
  const categoryPostings = base.lines.map((line) =>
    line.mark === 'deduction'
      ? posting(line.categoryId, line.amount, 'deduction')
      : posting(line.categoryId, -line.amount, line.mark),
  );
  const received = -sumCents(categoryPostings.map((p) => p.amount));
  return transaction(base, 'income', [posting(base.accountId, received), ...categoryPostings]);
}

/** A transfer between two of the user's own accounts. The source also pays any fee (LR-06, E-10 to E-13). */
export function transfer(
  base: Base & { fromId: string; toId: string; amount: Cents; fee?: CategoryLine },
): Transaction {
  const fee = base.fee?.amount ?? 0;
  const postings = [posting(base.fromId, -(base.amount + fee)), posting(base.toId, base.amount)];
  if (base.fee) postings.push(posting(base.fee.categoryId, base.fee.amount));
  return transaction(base, 'transfer', postings);
}

/**
 * A refund or reversal (E-31 to E-35): each line reverses its category. An expense
 * refund credits the expense category; an income reversal debits the income category.
 */
export function refund(
  chart: Chart,
  base: Base & { accountId: string; lines: CategoryLine[]; refundOfId?: string },
): Transaction {
  const categoryPostings = base.lines.map((line) => {
    const kind = chart.get(line.categoryId).kind;
    return posting(line.categoryId, kind === 'income' ? line.amount : -line.amount);
  });
  const accountAmount = -sumCents(categoryPostings.map((p) => p.amount));
  return transaction(base, 'refund', [posting(base.accountId, accountAmount), ...categoryPostings], base.refundOfId);
}

/** A debt payment: principal transfer plus interest and fee expense lines (BR-10.6, E-27). */
export function debtPayment(
  base: Base & { fromId: string; liabilityId: string; principal: Cents; extras?: CategoryLine[] },
): Transaction {
  const extras = (base.extras ?? []).map((line) => posting(line.categoryId, line.amount));
  const total = base.principal + sumCents(extras.map((p) => p.amount));
  return transaction(base, 'debt_payment', [
    posting(base.fromId, -total),
    posting(base.liabilityId, base.principal),
    ...extras,
  ]);
}

/** A general split with any balanced mix of category and user-account lines (§5.4, E-30). */
export function split(base: Base & { lines: { ledgerAccountId: string; amount: Cents; mark?: LineMark }[] }): Transaction {
  return transaction(
    base,
    'split',
    base.lines.map((line) => posting(line.ledgerAccountId, line.amount, line.mark)),
  );
}

/**
 * A balance adjustment (FR-18, E-36/E-37). `delta` is the signed change to the account's
 * balance as the user sees it. The counter-account is ADJ unless the user picked a category.
 */
export function adjustment(
  chart: Chart,
  base: Base & { accountId: string; delta: Cents; counterId?: string },
): Transaction {
  const account = chart.get(base.accountId);
  const signed = account.kind === 'liability' ? -base.delta : base.delta;
  const counterId = base.counterId ?? chart.system('ADJ').id;
  return transaction(base, 'adjustment', [posting(account.id, signed), posting(counterId, -signed)]);
}

/** A valuation change of an investment or other asset against VAL (E-43): never income (LR-12). */
export function valuation(chart: Chart, base: Base & { accountId: string; delta: Cents }): Transaction {
  return transaction(base, 'valuation', [posting(base.accountId, base.delta), posting(chart.system('VAL').id, -base.delta)]);
}
