/**
 * Runs golden scenarios against the pure domain module, in memory.
 * Every transaction is built from an intention and validated exactly as the
 * application services will do it.
 */
import {
  build,
  Chart,
  Ledger,
  parseAmount,
  validateTransaction,
  type AccountClass,
  type AccountType,
  type CategoryLine,
  type LedgerAccount,
  type Transaction,
} from '@fintrack/domain';
import type { Line, Op, Scenario } from './scenario.ts';

/** The latest date any scenario uses; transactions are validated against it as "today". */
const VALIDATION_TODAY = '2026-12-31';

const CLASS_BY_TYPE: Record<AccountType, AccountClass> = {
  current: 'cash',
  savings: 'cash',
  cash: 'cash',
  investment: 'investment',
  lent: 'other_asset',
  other_asset: 'other_asset',
  card: 'liability',
  loan: 'liability',
  other_liability: 'liability',
};

/** Categories the scenarios use (§6.1 plus the brief's defaults). */
const CATEGORIES: Record<string, { kind: 'income' | 'expense'; parent?: string }> = {
  Salary: { kind: 'income' },
  Food: { kind: 'expense' },
  Household: { kind: 'expense' },
  'Personal care': { kind: 'expense' },
  Shopping: { kind: 'expense' },
  Clothing: { kind: 'expense', parent: 'Shopping' },
  Electronics: { kind: 'expense' },
  'Bank fees': { kind: 'expense' },
  Interest: { kind: 'expense' },
  Rent: { kind: 'expense' },
  Utilities: { kind: 'expense' },
};

const BASELINES: Record<Scenario['base'], Op[]> = {
  none: [],
  B0: [
    { op: 'account', name: 'Current', type: 'current', opening: '1000.00' },
    { op: 'account', name: 'Cash wallet', type: 'cash', opening: '100.00' },
    { op: 'account', name: 'Savings', type: 'savings', opening: '2000.00', spendable: false },
  ],
  B1: [
    { op: 'account', name: 'Current', type: 'current', opening: '3000.00' },
    { op: 'account', name: 'Cash wallet', type: 'cash', opening: '100.00' },
    { op: 'account', name: 'Savings', type: 'savings', opening: '2000.00', spendable: false },
  ],
};

export class MemoryBook {
  readonly chart = new Chart();
  readonly transactions: Transaction[] = [];
  private readonly refs = new Map<string, string>();
  private sequence = 0;

  constructor() {
    for (const code of ['OBE', 'ADJ', 'VAL', 'CNV'] as const) {
      this.chart.add({ id: `sys:${code}`, kind: 'equity', name: code, systemCode: code });
    }
    for (const [name, info] of Object.entries(CATEGORIES)) {
      const account: LedgerAccount = { id: name, kind: info.kind, name, category: {} };
      if (info.parent) account.category = { parentId: info.parent };
      this.chart.add(account);
    }
  }

  get ledger(): Ledger {
    return new Ledger(this.chart, this.transactions);
  }

  apply(op: Op): void {
    if (op.op === 'account') {
      this.openAccount(op);
      return;
    }
    const tx = this.buildTransaction(op);
    validateTransaction(tx, this.chart, { today: VALIDATION_TODAY });
    this.transactions.push(tx);
    if (op.ref) this.refs.set(op.ref, tx.id);
  }

  private openAccount(op: Extract<Op, { op: 'account' }>): void {
    const accountClass = CLASS_BY_TYPE[op.type];
    const openingDate = op.date ?? '2026-03-01';
    this.chart.add({
      id: op.name,
      kind: accountClass === 'liability' ? 'liability' : 'asset',
      name: op.name,
      account: {
        class: accountClass,
        type: op.type,
        spendable: op.spendable ?? accountClass === 'cash',
        cardReserve: op.cardReserve ?? op.type === 'card',
        openingDate,
      },
    });
    const opening = build.openingBalance(this.chart, {
      id: this.nextId(),
      date: openingDate,
      accountId: op.name,
      amount: parseAmount(op.opening ?? '0'),
    });
    if (opening) {
      validateTransaction(opening, this.chart, { today: VALIDATION_TODAY });
      this.transactions.push(opening);
    }
  }

  private buildTransaction(op: Exclude<Op, { op: 'account' }>): Transaction {
    const id = this.nextId();
    switch (op.op) {
      case 'expense':
        return build.expense({ id, date: op.date, accountId: op.account, lines: categoryLines(op.lines) });
      case 'income':
        return build.income({ id, date: op.date, accountId: op.account, lines: categoryLines(op.lines) });
      case 'transfer': {
        const base = { id, date: op.date, fromId: op.from, toId: op.to, amount: parseAmount(op.amount) };
        return op.fee ? build.transfer({ ...base, fee: categoryLines([op.fee])[0]! }) : build.transfer(base);
      }
      case 'refund': {
        const base = { id, date: op.date, accountId: op.account, lines: categoryLines(op.lines) };
        const refundOfId = op.of === undefined ? undefined : this.refs.get(op.of);
        return refundOfId === undefined ? build.refund(this.chart, base) : build.refund(this.chart, { ...base, refundOfId });
      }
      case 'debtPayment':
        return build.debtPayment({
          id,
          date: op.date,
          fromId: op.from,
          liabilityId: op.to,
          principal: parseAmount(op.principal),
          extras: categoryLines(op.extras ?? []),
        });
      case 'split':
        return build.split({
          id,
          date: op.date,
          lines: op.lines.map(([name, amount]) => ({ ledgerAccountId: name, amount: parseAmount(amount) })),
        });
    }
  }

  private nextId(): string {
    this.sequence += 1;
    return `tx-${this.sequence}`;
  }
}

function categoryLines(lines: readonly Line[]): CategoryLine[] {
  return lines.map(([categoryId, amount]) => ({ categoryId, amount: parseAmount(amount) }));
}

/** Builds the scenario's book: baseline accounts, then its steps in order. */
export function runInMemory(scenario: Scenario): MemoryBook {
  const book = new MemoryBook();
  for (const op of [...BASELINES[scenario.base], ...scenario.steps]) book.apply(op);
  return book;
}
