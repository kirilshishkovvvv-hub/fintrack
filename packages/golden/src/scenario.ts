/**
 * Golden test scenarios as data (Stage 2 §12.2). Each Stage 1 GT becomes one Scenario.
 * The same data is run by several harnesses: the pure domain runner now, and the
 * database and API runners when those layers exist. Amounts are decimal strings.
 */
import type { AccountType } from '@fintrack/domain';

export type Amount = string;
export type Line = readonly [name: string, amount: Amount];

/** An intention that creates a transaction. `ref` names it for later steps. */
export type TransactionOp =
  | { op: 'expense'; date: string; account: string; lines: Line[]; ref?: string }
  | { op: 'income'; date: string; account: string; lines: Line[]; ref?: string }
  | { op: 'transfer'; date: string; from: string; to: string; amount: Amount; fee?: Line; ref?: string }
  | { op: 'refund'; date: string; account: string; lines: Line[]; of?: string; ref?: string }
  | { op: 'debtPayment'; date: string; from: string; to: string; principal: Amount; extras?: Line[]; ref?: string }
  /** General split with signed amounts: positive = debit. */
  | { op: 'split'; date: string; lines: Line[]; ref?: string };

export type Op =
  | {
      op: 'account';
      name: string;
      type: AccountType;
      /** Balance for assets, amount owed for liabilities. Defaults to 0. */
      opening?: Amount;
      date?: string;
      spendable?: boolean;
      cardReserve?: boolean;
    }
  | TransactionOp
  /** Replaces the referenced transaction with a new intention (E-38, LR-10). */
  | { op: 'edit'; ref: string; to: TransactionOp }
  /** Lifecycle changes (§9.3). */
  | { op: 'void' | 'trash' | 'restore'; ref: string };

export interface FlowCheck {
  from: string;
  to: string;
  income?: Amount;
  expenses?: Amount;
  netResult?: Amount;
  cashChange?: Amount;
  byCategory?: Record<string, Amount>;
  /** Asserts the Net Worth Change identity over this period. */
  netWorthIdentity?: true;
}

export interface BudgetCheck {
  category: string;
  month: string;
  limit: Amount;
  spent: Amount;
  /** Utilization as displayed (AM-3), e.g. "23.0 %". */
  display: string;
}

export interface Check {
  /** The evaluation date for balances and Safe to Spend ("today"). */
  at: string;
  balances?: Record<string, Amount>;
  assets?: Amount;
  liabilities?: Amount;
  netWorth?: Amount;
  safeToSpend?: Amount;
  flows?: FlowCheck[];
  budgets?: BudgetCheck[];
}

export interface Scenario {
  id: string;
  title: string;
  /** Baseline accounts to start from (§6.1). */
  base: 'B0' | 'B1' | 'none';
  steps: Op[];
  checks: Check[];
  /** Parts of the Stage 1 test that need later features. They're listed, not silently skipped. */
  deferred?: { what: string; stage: number }[];
}
