import type { Cents } from './money.ts';
import type { IsoDate } from './dates.ts';

/** Ledger account kinds (§2.3). Positive postings are debits. */
export type LedgerKind = 'asset' | 'liability' | 'income' | 'expense' | 'equity';

/** Hidden system accounts (§2.3). TIT is a Cash-class asset; the rest are equity. */
export type SystemCode = 'OBE' | 'ADJ' | 'VAL' | 'CNV' | 'TIT';

export type AccountClass = 'cash' | 'investment' | 'other_asset' | 'liability';

export type AccountType =
  | 'current'
  | 'savings'
  | 'cash'
  | 'investment'
  | 'lent'
  | 'other_asset'
  | 'card'
  | 'loan'
  | 'other_liability';

export interface UserAccountInfo {
  class: AccountClass;
  type: AccountType;
  spendable: boolean;
  cardReserve: boolean;
  openingDate: IsoDate;
}

export interface LedgerAccount {
  id: string;
  kind: LedgerKind;
  name: string;
  archived?: boolean;
  systemCode?: SystemCode;
  /** Present for user accounts (asset or liability the user owns). */
  account?: UserAccountInfo;
  /** Present for categories (income or expense). */
  category?: { parentId?: string };
}

export type TransactionKind =
  | 'expense'
  | 'income'
  | 'transfer'
  | 'refund'
  | 'debt_payment'
  | 'split'
  | 'opening_balance'
  | 'adjustment'
  | 'valuation';

export type TransactionStatus = 'posted' | 'voided' | 'trashed';

/** A marked line inside an expense or income: a discount or a deduction (LR-15). */
export type LineMark = 'discount' | 'deduction';

export interface Posting {
  ledgerAccountId: string;
  /** Signed cents: positive = debit, negative = credit. Never zero (LR-02). */
  amount: Cents;
  mark?: LineMark;
}

export interface Transaction {
  id: string;
  date: IsoDate;
  kind: TransactionKind;
  status: TransactionStatus;
  postings: Posting[];
  refundOfId?: string;
}

/** The workspace's set of ledger accounts, looked up by ID. */
export class Chart {
  private readonly byId = new Map<string, LedgerAccount>();

  constructor(accounts: Iterable<LedgerAccount> = []) {
    for (const account of accounts) this.add(account);
  }

  add(account: LedgerAccount): LedgerAccount {
    if (this.byId.has(account.id)) {
      throw new Error(`Duplicate ledger account id: ${account.id}`);
    }
    this.byId.set(account.id, account);
    return account;
  }

  get(id: string): LedgerAccount {
    const account = this.byId.get(id);
    if (!account) throw new Error(`Unknown ledger account: ${id}`);
    return account;
  }

  find(id: string): LedgerAccount | undefined {
    return this.byId.get(id);
  }

  all(): LedgerAccount[] {
    return [...this.byId.values()];
  }

  system(code: SystemCode): LedgerAccount {
    const account = this.all().find((candidate) => candidate.systemCode === code);
    if (!account) throw new Error(`System account ${code} is missing`);
    return account;
  }

  /** The category and all of its subcategories. */
  categorySubtree(categoryId: string): Set<string> {
    const ids = new Set([categoryId]);
    for (const account of this.all()) {
      if (account.category?.parentId === categoryId) ids.add(account.id);
    }
    return ids;
  }
}

export function isUserAccount(account: LedgerAccount): boolean {
  return account.account !== undefined;
}

export function isCategory(account: LedgerAccount): boolean {
  return account.kind === 'income' || account.kind === 'expense';
}
