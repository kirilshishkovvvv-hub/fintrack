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
  assertCanAllocate,
  matchingWindowDays,
  scheduledDates,
  shiftForNonWorkingDay,
  validateTransaction,
  type AccountClass,
  type AccountType,
  type CategoryLine,
  type Allocation,
  type LedgerAccount,
  type PlannedItem,
  type Schedule,
  type Transaction,
} from '@fintrack/domain';
import type { Line, Op, PlanTemplate, Scenario, TransactionOp } from './scenario.ts';

/** Everything Safe to Spend needs besides the ledger, as it stood on one date. */
export interface PlanningState {
  planned: PlannedItem[];
  allocations: Allocation[];
  protectedReserve: number;
  countSavingsTransfers: boolean;
  /** Goal progress by name: backed money is worked out from `allocations`; this is dedicated accounts. */
  dedicated: Map<string, string[]>;
  goals: string[];
}

/** Allocations made without a date in a scenario happen before anything else. */
const FIRST_DAY = '2026-03-01';

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
  Cashback: { kind: 'income' },
  Food: { kind: 'expense' },
  Travel: { kind: 'expense' },
  Transport: { kind: 'expense' },
  Entertainment: { kind: 'expense' },
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
  private readonly rules = new Map<string, PlanTemplate & { schedule?: Schedule; date?: string; payday: boolean; estimated: boolean }>();
  /** Completed or skipped occurrences: `rule|original` to the date it happened. */
  private readonly closed = new Map<string, string>();
  private readonly allocationEvents: { on: string; goal: string; account: string; delta: number }[] = [];
  private readonly goalNames: string[] = [];
  private readonly dedicated = new Map<string, string[]>();
  private protectedReserve = 0;
  private countSavingsTransfers = true;

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
      case 'rule': {
        const start = op.start ?? FIRST_DAY;
        const schedule: Schedule = { frequency: op.frequency ?? 'monthly_day', startDate: start, nonWorkingDay: op.nonWorkingDay ?? 'on_date' };
        if (op.day !== undefined) schedule.anchorDay = op.day;
        this.rules.set(op.name, { ...op, schedule, payday: op.payday === true, estimated: op.estimated === true });
        return;
      }
      case 'plan':
        this.rules.set(op.name, { ...op, payday: false, estimated: false });
        return;
      case 'confirm': {
        this.close(op.rule, op.original, op.on);
        this.post(this.fromTemplate(this.ruleNamed(op.rule), op.on, op.amount));
        return;
      }
      case 'link':
        this.indexOf(op.ref);
        this.close(op.rule, op.original, op.on);
        return;
      case 'skip':
        this.close(op.rule, op.original, op.on);
        return;
      case 'goal':
        this.goalNames.push(op.name);
        return;
      case 'allocate': {
        const on = op.on ?? FIRST_DAY;
        const amount = parseAmount(op.amount);
        const refused = () => {
          if ([...this.dedicated.values()].some((accounts) => accounts.includes(op.account))) throw new Error(`${op.account} is dedicated to a goal (G-D3)`);
          assertCanAllocate(this.ledger.balance(op.account, on), this.allocatedOn(op.account, on), amount);
        };
        if (op.rejected) {
          let threw = false;
          try {
            refused();
          } catch {
            threw = true;
          }
          if (!threw) throw new Error(`Allocating ${op.amount} on ${op.account} should have been refused`);
          return;
        }
        refused();
        this.allocationEvents.push({ on, goal: op.goal, account: op.account, delta: amount });
        return;
      }
      case 'release':
        this.allocationEvents.push({ on: op.on ?? FIRST_DAY, goal: op.goal, account: op.account, delta: -parseAmount(op.amount) });
        return;
      case 'moveAllocation': {
        const on = op.on ?? FIRST_DAY;
        const amount = parseAmount(op.amount);
        assertCanAllocate(this.ledger.balance(op.to, on), this.allocatedOn(op.to, on), amount);
        this.allocationEvents.push({ on, goal: op.goal, account: op.from, delta: -amount }, { on, goal: op.goal, account: op.to, delta: amount });
        return;
      }
      case 'dedicate':
        this.dedicated.set(op.goal, [...(this.dedicated.get(op.goal) ?? []), op.account]);
        this.chart.get(op.account).account!.spendable = false;
        return;
      case 'setReserve':
        this.protectedReserve = parseAmount(op.amount);
        return;
      case 'setSavingsTransfers':
        this.countSavingsTransfers = op.count;
        return;
      default: {
        const tx = this.buildTransaction(op);
        this.post(tx);
        if (op.ref) this.refs.set(op.ref, tx.id);
      }
    }
  }

  /** The plans and goal money as they stood on a date: later completions and allocations haven't happened yet. */
  planningAt(at: string): PlanningState {
    const planned: PlannedItem[] = [];
    const until = new Date(Date.parse(`${at}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
    for (const [name, rule] of this.rules) {
      const dates = rule.schedule ? scheduledDates(rule.schedule, until) : [{ originalDate: rule.date!, dueDate: shiftForNonWorkingDay(rule.date!) }];
      for (const date of dates) {
        const closedOn = this.closed.get(`${name}|${date.originalDate}`);
        if (closedOn !== undefined && closedOn <= at) continue;
        planned.push(this.toItem(name, rule, date));
      }
    }
    const totals = new Map<string, Allocation>();
    for (const event of this.allocationEvents) {
      if (event.on > at) continue;
      const key = `${event.goal}|${event.account}`;
      const current = totals.get(key) ?? { goalId: event.goal, accountId: event.account, amount: 0, goalOrder: this.goalNames.indexOf(event.goal) };
      totals.set(key, { ...current, amount: current.amount + event.delta });
    }
    return {
      planned,
      allocations: [...totals.values()].filter((allocation) => allocation.amount > 0),
      protectedReserve: this.protectedReserve,
      countSavingsTransfers: this.countSavingsTransfers,
      dedicated: this.dedicated,
      goals: this.goalNames,
    };
  }

  private toItem(name: string, rule: PlanTemplate & { schedule?: Schedule; payday: boolean; estimated: boolean }, date: { originalDate: string; dueDate: string }): PlannedItem {
    const lines = [...(rule.lines ?? []), ...(rule.extras ?? [])].map(([categoryId, amount]) => ({ categoryId, amount: parseAmount(amount) }));
    const base = rule.kind === 'transfer' ? parseAmount(rule.amount!) : rule.kind === 'debtPayment' ? parseAmount(rule.principal!) : 0;
    return {
      id: `${name}|${date.originalDate}`,
      name,
      kind: rule.kind === 'debtPayment' ? 'debt_payment' : rule.kind,
      originalDate: date.originalDate,
      dueDate: date.dueDate,
      amount: base + lines.reduce((total, line) => total + line.amount, 0),
      fromAccountId: rule.from ?? null,
      toAccountId: rule.to ?? null,
      lines,
      isPayday: rule.payday,
      goalId: rule.goal ?? null,
      amountType: rule.estimated ? 'estimated' : 'fixed',
      windowDays: matchingWindowDays(rule.schedule ?? null),
    };
  }

  private ruleNamed(name: string) {
    const rule = this.rules.get(name);
    if (!rule) throw new Error(`No rule named ${name}`);
    return rule;
  }

  /** BR-08.4: an occurrence is completed, linked or skipped once. */
  private close(rule: string, original: string, on: string): void {
    const key = `${rule}|${original}`;
    if (this.closed.has(key)) throw new Error(`${key} is already closed`);
    this.closed.set(key, on);
  }

  private allocatedOn(account: string, on: string): number {
    return this.allocationEvents.filter((event) => event.account === account && event.on <= on).reduce((total, event) => total + event.delta, 0);
  }

  private fromTemplate(rule: PlanTemplate, on: string, amount?: string): Transaction {
    const lines = (rule.lines ?? []).map(([name, value]): Line => [name, amount ?? value]);
    switch (rule.kind) {
      case 'expense':
        return this.buildTransaction({ op: 'expense', date: on, account: rule.from!, lines });
      case 'income':
        return this.buildTransaction({ op: 'income', date: on, account: rule.to!, lines });
      case 'transfer':
        return this.buildTransaction({ op: 'transfer', date: on, from: rule.from!, to: rule.to!, amount: amount ?? rule.amount! });
      case 'debtPayment':
        return this.buildTransaction({ op: 'debtPayment', date: on, from: rule.from!, to: rule.to!, principal: rule.principal!, extras: rule.extras ?? [] });
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
