/**
 * Golden test scenarios as data (Stage 2 §12.2). Each Stage 1 GT becomes one Scenario.
 * The same data is run by several harnesses: the pure domain runner now, and the
 * database and API runners when those layers exist. Amounts are decimal strings.
 */
import type { AccountType, Frequency, NonWorkingDay } from '@fintrack/domain';

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
  | { op: 'void' | 'trash' | 'restore'; ref: string }
  /**
   * Reconciles every posted transaction of the account up to `date` against the statement
   * (FR-18). Any difference is closed by an adjustment to ADJ, or to the named category.
   */
  | { op: 'reconcile'; account: string; date: string; statement: Amount; adjustTo?: 'ADJ' | string }
  /** Quick balance update (FR-18): the actual value; a category means "I spent it" (E-37). */
  | { op: 'balanceUpdate'; account: string; date: string; actual: Amount; category?: string }
  /** Archives an account or category (E-58, E-59). */
  | { op: 'archive'; name: string }
  /** Merges one category into another of the same kind (E-59). */
  | { op: 'merge'; from: string; into: string }
  /** A monthly (or other) recurring rule. It's active from the scenario's start. */
  | (PlanTemplate & { op: 'rule'; day?: number; frequency?: Frequency; start?: string; payday?: true; estimated?: true; nonWorkingDay?: NonWorkingDay })
  /** A one-off planned item. */
  | (PlanTemplate & { op: 'plan'; date: string })
  /** Completes an occurrence by creating the actual transaction from its template (BR-08.5). */
  | { op: 'confirm'; rule: string; original: string; on: string; amount?: Amount }
  /** Completes an occurrence by linking an existing transaction (BR-08.5). */
  | { op: 'link'; rule: string; original: string; ref: string; on: string }
  | { op: 'skip'; rule: string; original: string; on: string }
  | { op: 'goal'; name: string; target?: Amount }
  /** `rejected` asserts the operation is refused, and that nothing changes. */
  | { op: 'allocate'; goal: string; account: string; amount: Amount; on?: string; rejected?: true }
  | { op: 'release'; goal: string; account: string; amount: Amount; on?: string }
  | { op: 'moveAllocation'; goal: string; from: string; to: string; amount: Amount; on?: string }
  | { op: 'dedicate'; goal: string; account: string }
  | { op: 'setReserve'; amount: Amount }
  | { op: 'setSavingsTransfers'; count: boolean };

/** What a rule or one-off plan will do when it's completed. */
export interface PlanTemplate {
  name: string;
  kind: 'expense' | 'income' | 'transfer' | 'debtPayment';
  from?: string;
  to?: string;
  lines?: Line[];
  amount?: Amount;
  principal?: Amount;
  extras?: Line[];
  /** R5: the goal whose money covers it. */
  goal?: string;
}

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
  /** The thresholds reached, from 80 and 100 (BR-07.7). */
  crossed?: number[];
}

export interface ScheduledCheck {
  category: string;
  month: string;
  amount: Amount;
}

export interface Check {
  /** The evaluation date for balances and Safe to Spend ("today"). */
  at: string;
  balances?: Record<string, Amount>;
  assets?: Amount;
  liabilities?: Amount;
  netWorth?: Amount;
  safeToSpend?: Amount;
  /** The terms of Safe to Spend (§7.4), and the last day of its window. */
  uco?: Amount;
  uga?: Amount;
  windowTo?: string;
  perDay?: Amount;
  /** Names of the items on each information line (§7.10). */
  dueOnPayday?: string[];
  latePayday?: string[];
  expectedIncome?: string[];
  /** Backed amount per goal (§8.1), and progress of dedicated goals. */
  backed?: Record<string, Amount>;
  progress?: Record<string, Amount>;
  scheduled?: ScheduledCheck[];
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
