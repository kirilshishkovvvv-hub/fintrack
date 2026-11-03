/**
 * Runs golden scenarios against the pure domain module, in memory.
 * Every transaction is built from an intention and validated exactly as the
 * application services will do it.
 */
import {
  balanceUpdateDelta,
  build,
  Chart,
  Ledger,
  parseAmount,
  reconcile,
  validateTransaction,
  type AccountClass,
  type AccountType,
  type CategoryLine,
  type LedgerAccount,
  type Transaction,
} from '@fintrack/domain';
import type { Line, Op, Scenario, TransactionOp } from './scenario.ts';

/** What happened to the book, in order, so other harnesses can replay it through their own layer. */
export type BookEvent =
  | { type: 'insert'; tx: Transaction }
  | { type: 'replace'; tx: Transaction }
  | { type: 'status'; id: string; status: Transaction['status'] }
  | { type: 'archive'; ledgerAccountId: string }
  | { type: 'merge'; fromId: string; intoId: string };

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
  Restaurants: { kind: 'expense' },
  'Untracked spending': { kind: 'expense' },
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
  readonly events: BookEvent[] = [];
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
    switch (op.op) {
      case 'account':
        this.openAccount(op);
        return;
      case 'edit': {
        const index = this.indexOf(op.ref);
        if (this.transactions[index]!.status !== 'posted') throw new Error(`${op.ref} is not posted and can't be edited`);
        const tx = this.buildTransaction(op.to, this.transactions[index]!.id);
        validateTransaction(tx, this.chart, { today: VALIDATION_TODAY });
        this.transactions[index] = tx;
        this.events.push({ type: 'replace', tx });
        return;
      }
      case 'void':
      case 'trash':
      case 'restore': {
        const index = this.indexOf(op.ref);
        const tx = this.transactions[index]!;
        const allowed = op.op === 'restore' ? tx.status !== 'posted' : tx.status === 'posted';
        if (!allowed) throw new Error(`Can't ${op.op} ${op.ref} while it is ${tx.status}`);
        const status = op.op === 'restore' ? 'posted' : op.op === 'void' ? 'voided' : 'trashed';
        if (status === 'posted') validateTransaction({ ...tx, status }, this.chart, { today: VALIDATION_TODAY });
        this.transactions[index] = { ...tx, status };
        this.events.push({ type: 'status', id: tx.id, status });
        return;
      }
      case 'reconcile': {
        const cleared = new Set(
          this.transactions
            .filter((tx) => tx.status === 'posted' && tx.date <= op.date && tx.postings.some((p) => p.ledgerAccountId === op.account))
            .map((tx) => tx.id),
        );
        const figures = reconcile(this.ledger, { accountId: op.account, statementBalance: parseAmount(op.statement), cleared });
        if (figures.difference === 0) return;
        if (!op.adjustTo) throw new Error(`Reconciling ${op.account} leaves a difference of ${figures.difference}`);
        const counter = op.adjustTo === 'ADJ' ? {} : { counterId: op.adjustTo };
        this.post(build.adjustment(this.chart, { id: this.nextId(), date: op.date, accountId: op.account, delta: figures.adjustment, ...counter }));
        return;
      }
      case 'balanceUpdate': {
        const delta = balanceUpdateDelta(this.ledger, { accountId: op.account, date: op.date, actual: parseAmount(op.actual) });
        if (delta === 0) return;
        const base = { id: this.nextId(), date: op.date, accountId: op.account, delta };
        const cash = this.chart.get(op.account).account?.class === 'cash';
        this.post(
          cash
            ? build.adjustment(this.chart, op.category ? { ...base, counterId: op.category } : base)
            : build.valuation(this.chart, base),
        );
        return;
      }
      case 'archive': {
        const account = this.chart.get(op.name);
        if (account.account && this.ledger.rawBalance(op.name, VALIDATION_TODAY) !== 0) {
          throw new Error(`${op.name} can't be archived with a balance (AC-19.3)`);
        }
        this.chart.markArchived(op.name);
        this.events.push({ type: 'archive', ledgerAccountId: op.name });
        return;
      }
      case 'merge': {
        for (const [index, tx] of this.transactions.entries()) {
          if (!tx.postings.some((p) => p.ledgerAccountId === op.from)) continue;
          this.transactions[index] = {
            ...tx,
            postings: tx.postings.map((p) => (p.ledgerAccountId === op.from ? { ...p, ledgerAccountId: op.into } : p)),
          };
        }
        this.chart.markArchived(op.from);
        this.events.push({ type: 'merge', fromId: op.from, intoId: op.into });
        return;
      }
      default: {
        const tx = this.buildTransaction(op);
        this.post(tx);
        if (op.ref) this.refs.set(op.ref, tx.id);
      }
    }
  }

  private post(tx: Transaction): void {
    validateTransaction(tx, this.chart, { today: VALIDATION_TODAY });
    this.transactions.push(tx);
    this.events.push({ type: 'insert', tx });
  }

  private indexOf(ref: string): number {
    const id = this.refs.get(ref);
    const index = this.transactions.findIndex((tx) => tx.id === id);
    if (index < 0) throw new Error(`No transaction named ${ref}`);
    return index;
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
      this.events.push({ type: 'insert', tx: opening });
    }
  }

  private buildTransaction(op: TransactionOp, id = this.nextId()): Transaction {
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
