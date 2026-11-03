import { isIsoDate, type IsoDate } from './dates.ts';
import { Chart, isCategory, isUserAccount, type LedgerAccount, type Posting, type Transaction, type TransactionKind } from './ledger.ts';
import { MAX_ABS_CENTS } from './money.ts';

export interface LedgerViolation {
  rule: string;
  message: string;
}

export class LedgerError extends Error {
  override name = 'LedgerError';

  constructor(readonly violations: LedgerViolation[]) {
    super(violations.map((violation) => `${violation.rule}: ${violation.message}`).join('; '));
  }
}

export interface ValidationContext {
  /** Today in the workspace time zone (A-8: actual transactions can't be future-dated). */
  today: IsoDate;
}

/** Which equity account each system kind may use (LR-05). No other kind may touch equity. */
const EQUITY_BY_KIND: Partial<Record<TransactionKind, 'OBE' | 'ADJ' | 'VAL'>> = {
  opening_balance: 'OBE',
  adjustment: 'ADJ',
  valuation: 'VAL',
};

interface Line {
  posting: Posting;
  account: LedgerAccount;
}

/** Throws a LedgerError listing every rule the transaction breaks. */
export function validateTransaction(tx: Transaction, chart: Chart, context: ValidationContext): void {
  const violations = checkTransaction(tx, chart, context);
  if (violations.length > 0) throw new LedgerError(violations);
}

/** Checks a transaction against the ledger rules in §5.2 and the posting patterns in §5.4. */
export function checkTransaction(tx: Transaction, chart: Chart, context: ValidationContext): LedgerViolation[] {
  const violations: LedgerViolation[] = [];
  const fail = (rule: string, message: string) => violations.push({ rule, message });

  if (!isIsoDate(tx.date)) {
    fail('LR-04', `invalid date "${tx.date}"`);
  } else if (tx.date > context.today) {
    fail('LR-04', 'actual transactions cannot be dated in the future; schedule a planned item instead');
  }

  if (tx.postings.length < 2) fail('LR-02', 'a transaction needs at least 2 postings');

  const lines: Line[] = [];
  for (const posting of tx.postings) {
    if (!Number.isSafeInteger(posting.amount) || Math.abs(posting.amount) > MAX_ABS_CENTS) {
      fail('LR-17', `posting amount ${posting.amount} is not a valid number of cents`);
    } else if (posting.amount === 0) {
      fail('LR-02', 'postings must be non-zero');
    }
    const account = chart.find(posting.ledgerAccountId);
    if (!account) {
      fail('BR-02.3', `unknown ledger account ${posting.ledgerAccountId}`);
      continue;
    }
    if (account.archived) fail('LR-14', `${account.name} is archived`);
    lines.push({ posting, account });
  }
  if (lines.length !== tx.postings.length) return violations;

  const sum = tx.postings.reduce((total, posting) => total + posting.amount, 0);
  if (sum !== 0) fail('LR-01', `postings sum to ${sum}, not 0`);

  const userLines = lines.filter((line) => isUserAccount(line.account));
  if (userLines.length === 0) fail('LR-02', 'a transaction must touch at least one user account');

  if (isIsoDate(tx.date)) {
    for (const { account } of userLines) {
      const opened = account.account?.openingDate;
      if (opened && tx.date < opened) {
        fail('LR-04', `${account.name} was opened on ${opened}, after ${tx.date}`);
      }
    }
  }

  checkEquity(tx.kind, lines, fail);
  checkSignDirection(tx.kind, lines, fail);
  checkPattern(tx.kind, lines, userLines, fail);
  return violations;
}

function checkEquity(kind: TransactionKind, lines: Line[], fail: (rule: string, message: string) => void) {
  const allowed = EQUITY_BY_KIND[kind];
  for (const { account } of lines) {
    if (account.kind !== 'equity') continue;
    if (account.systemCode !== allowed) {
      fail('LR-05', `${kind} transactions cannot post to ${account.systemCode ?? account.name}`);
    }
  }
}

/** LR-15: reversing category lines only in refunds, or as explicitly marked lines. */
function checkSignDirection(kind: TransactionKind, lines: Line[], fail: (rule: string, message: string) => void) {
  for (const { posting, account } of lines) {
    if (!isCategory(account)) continue;
    const reversing =
      (account.kind === 'expense' && posting.amount < 0) || (account.kind === 'income' && posting.amount > 0);
    if (kind === 'refund') {
      if (!reversing) fail('LR-15', `a refund line on ${account.name} must reverse it`);
      continue;
    }
    if (kind === 'adjustment') continue;
    if (reversing && posting.mark === undefined) {
      fail('LR-15', `a reversing line on ${account.name} needs a refund, or a discount or deduction mark`);
    }
  }
}

function checkPattern(
  kind: TransactionKind,
  lines: Line[],
  userLines: Line[],
  fail: (rule: string, message: string) => void,
) {
  const rule = '§5.4';
  const categoryLines = lines.filter((line) => isCategory(line.account));
  const income = categoryLines.filter((line) => line.account.kind === 'income');
  const expense = categoryLines.filter((line) => line.account.kind === 'expense');
  const equity = lines.filter((line) => line.account.kind === 'equity');
  const only = (count: number, what: string) => {
    if (userLines.length !== count) fail(rule, `${kind} needs exactly ${count} ${what}`);
  };

  switch (kind) {
    case 'expense': {
      only(1, 'paying account');
      if (userLines[0] && userLines[0].posting.amount > 0) fail(rule, 'the paying account must be credited');
      if (!expense.some((line) => line.posting.amount > 0)) fail(rule, 'an expense needs an expense category line');
      if (income.length > 0) fail(rule, 'an expense cannot contain income lines');
      break;
    }
    case 'income': {
      only(1, 'receiving account');
      if (userLines[0] && userLines[0].posting.amount < 0) fail(rule, 'the receiving account must be debited');
      if (!income.some((line) => line.posting.amount < 0)) fail(rule, 'income needs an income category line');
      if (expense.some((line) => line.posting.mark !== 'deduction')) {
        fail(rule, 'expense lines inside income must be marked as deductions');
      }
      break;
    }
    case 'transfer': {
      only(2, 'user accounts');
      const [first, second] = userLines;
      if (first && second) {
        if (first.account.id === second.account.id) fail(rule, 'a transfer needs two different accounts');
        if (Math.sign(first.posting.amount) === Math.sign(second.posting.amount)) {
          fail(rule, 'a transfer needs one source and one destination');
        }
      }
      if (income.length > 0) fail('LR-06', 'a transfer cannot contain income lines');
      if (expense.some((line) => line.posting.amount < 0)) fail('LR-06', 'fee lines must be expenses');
      break;
    }
    case 'refund': {
      only(1, 'account');
      if (categoryLines.length === 0) fail(rule, 'a refund needs a category line');
      break;
    }
    case 'debt_payment': {
      only(2, 'user accounts (source and liability)');
      const liability = userLines.find((line) => line.account.kind === 'liability' && line.posting.amount > 0);
      const source = userLines.find((line) => line.posting.amount < 0);
      if (!liability) fail(rule, 'a debt payment must reduce a liability');
      if (!source) fail(rule, 'a debt payment needs a paying account');
      if (income.length > 0) fail(rule, 'a debt payment cannot contain income lines');
      break;
    }
    case 'split': {
      if (equity.length > 0) fail('LR-05', 'a split cannot use equity accounts');
      break;
    }
    case 'opening_balance':
    case 'valuation': {
      if (lines.length !== 2 || userLines.length !== 1 || equity.length !== 1) {
        fail(rule, `${kind} needs exactly one user account and its system account`);
      }
      if (kind === 'valuation') {
        const accountClass = userLines[0]?.account.account?.class;
        if (accountClass !== 'investment' && accountClass !== 'other_asset') {
          fail('LR-18', 'valuation applies only to investment and other-asset accounts');
        }
      }
      break;
    }
    case 'adjustment': {
      const counter = lines.filter((line) => !isUserAccount(line.account));
      if (lines.length !== 2 || userLines.length !== 1 || counter.length !== 1) {
        fail(rule, 'an adjustment needs exactly one user account and ADJ or one category');
      }
      break;
    }
  }
}
