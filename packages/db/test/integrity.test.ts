/**
 * Database-level guarantees (Stage 2 §5.4, §7, §8.3), tested by trying to break them directly
 * with SQL as the application role, without going through any application code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build, type LedgerAccount } from '@fintrack/domain';
import { createWorkspace, insertLedgerAccount, insertTransaction, loadChart, uuidv7, withWorkspace, type Db } from '../src/index.ts';
import { startTestDatabase, type TestDatabase } from '../src/test-database.ts';

let database: TestDatabase;

interface Fixture {
  context: { workspaceId: string; userId: string };
  current: string;
  food: string;
  obe: string;
  closed: string;
  expenseId: string;
}

let a: Fixture;
let b: Fixture;

async function setUpWorkspace(label: string): Promise<Fixture> {
  const context = { workspaceId: uuidv7(), userId: `user-${label}` };
  const fixture = { context, current: uuidv7(), food: uuidv7(), closed: uuidv7(), obe: '', expenseId: uuidv7() };
  await withWorkspace(
    database.pool,
    context,
    async (db) => {
      await createWorkspace(db, { id: context.workspaceId, name: label, currency: 'EUR', timezone: 'Europe/Sofia', ownerUserId: context.userId });
      const userAccount = (id: string, name: string, archived = false): LedgerAccount => ({
        id,
        name,
        kind: 'asset',
        ...(archived ? { archived: true } : {}),
        account: { class: 'cash', type: 'current', spendable: true, cardReserve: false, openingDate: '2026-03-01' },
      });
      await insertLedgerAccount(db, context.workspaceId, userAccount(fixture.current, 'Current'));
      await insertLedgerAccount(db, context.workspaceId, userAccount(fixture.closed, 'Closed', true));
      await insertLedgerAccount(db, context.workspaceId, { id: fixture.food, name: 'Food', kind: 'expense', category: {} });
      const chart = await loadChart(db, context.workspaceId);
      fixture.obe = chart.system('OBE').id;
      const opening = build.openingBalance(chart, { id: uuidv7(), date: '2026-03-01', accountId: fixture.current, amount: 100000 })!;
      await insertTransaction(db, context.workspaceId, opening, { origin: 'system', userId: context.userId });
      const expense = build.expense({ id: fixture.expenseId, date: '2026-03-10', accountId: fixture.current, lines: [{ categoryId: fixture.food, amount: 4560 }] });
      await insertTransaction(db, context.workspaceId, expense, { origin: 'manual', userId: context.userId });
    },
    { write: true },
  );
  return fixture;
}

/** Inserts a transaction row and raw postings, bypassing the domain builders and validation. */
async function rawTransaction(db: Db, f: Fixture, kind: string, date: string, postings: [string, number][]): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO fin.transactions (id, workspace_id, txn_date, kind, origin) VALUES ($1, $2, $3, $4, 'manual')`,
    [id, f.context.workspaceId, date, kind],
  );
  let line = 0;
  for (const [accountId, amount] of postings) {
    line += 1;
    await db.query(
      `INSERT INTO fin.postings (id, workspace_id, transaction_id, txn_date, txn_status, ledger_account_id, amount_minor, currency, line_no)
       VALUES ($1, $2, $3, $4, 'posted', $5, $6, 'EUR', $7)`,
      [uuidv7(), f.context.workspaceId, id, date, accountId, amount, line],
    );
  }
  return id;
}

const asA = <T>(work: (db: Db) => Promise<T>) => withWorkspace(database.pool, a.context, work, { write: true });
const asB = <T>(work: (db: Db) => Promise<T>) => withWorkspace(database.pool, b.context, work, { write: true });

/** Asserts that the work fails with the given PostgreSQL error code (SQLSTATE). */
async function rejectsWith(code: string, work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  database = await startTestDatabase();
  a = await setUpWorkspace('A');
  b = await setUpWorkspace('B');
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('balancing at commit (LR-01, LR-02)', () => {
  test('an unbalanced transaction is rejected when the database transaction commits', async () => {
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.current, -1000], [a.food, 999]])));
  });

  test('a single posting and a transaction without postings are both rejected', async () => {
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.food, 1000]])));
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [])));
  });

  test('a balanced transaction without any user account is rejected', async () => {
    const other = uuidv7();
    await asA((db) => insertLedgerAccount(db, a.context.workspaceId, { id: other, name: 'Other', kind: 'expense', category: {} }));
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'split', '2026-03-11', [[a.food, 500], [other, -500]])));
  });

  test('zero postings and amounts beyond the limit violate the column check', async () => {
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.current, 0], [a.food, 0]])));
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.current, -1_000_000_000_000], [a.food, 1_000_000_000_000]])));
  });

  test('a failure leaves nothing behind (LR-03)', async () => {
    const before = await asA(async (db) => (await db.query('SELECT count(*)::int AS n FROM fin.transactions')).rows[0].n);
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.current, -1000], [a.food, 1]])));
    const after = await asA(async (db) => (await db.query('SELECT count(*)::int AS n FROM fin.transactions')).rows[0].n);
    expect(after).toBe(before);
  });
});

describe('ledger rules in the database (LR-04, LR-05, LR-14)', () => {
  test('future dates are rejected in the workspace time zone', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', future, [[a.current, -100], [a.food, 100]])));
  });

  test('postings before the account opening date are rejected', async () => {
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-02-28', [[a.current, -100], [a.food, 100]])));
  });

  test('archived accounts receive no postings', async () => {
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.closed, -100], [a.food, 100]])));
  });

  test('equity is reachable only through its own system kind', async () => {
    await rejectsWith('23514', asA((db) => rawTransaction(db, a, 'expense', '2026-03-11', [[a.current, 100], [a.obe, -100]])));
  });

  test('voiding a transaction removes its postings from balances at once', async () => {
    const id = await asA((db) => rawTransaction(db, a, 'expense', '2026-03-12', [[a.current, -700], [a.food, 700]]));
    const balance = () =>
      asA(async (db) =>
        Number(
          (
            await db.query(
              "SELECT COALESCE(sum(amount_minor), 0)::text AS s FROM fin.postings WHERE ledger_account_id = $1 AND txn_status = 'posted'",
              [a.current],
            )
          ).rows[0].s,
        ),
      );
    const before = await balance();
    await asA((db) => db.query("UPDATE fin.transactions SET status = 'voided', voided_at = now() WHERE id = $1", [id]));
    expect(await balance()).toBe(before + 700);
  });
});

describe('isolation between workspaces (FR-02, ISO-6, ISO-7)', () => {
  test("B sees none of A's rows in any table", async () => {
    const tables = ['workspaces', 'ledger_accounts', 'accounts', 'categories', 'transactions', 'postings', 'transaction_versions', 'audit_events'];
    await asB(async (db) => {
      for (const table of tables) {
        const result = await db.query(`SELECT count(*)::int AS n FROM fin.${table} WHERE workspace_id = $1`.replace(
          'workspace_id',
          table === 'workspaces' ? 'id' : 'workspace_id',
        ), [a.context.workspaceId]);
        expect(result.rows[0].n, `fin.${table}`).toBe(0);
      }
      expect((await db.query('SELECT * FROM fin.transactions WHERE id = $1', [a.expenseId])).rowCount).toBe(0);
    });
  });

  test("B can't change or relabel A's transaction", async () => {
    const updated = await asB((db) => db.query("UPDATE fin.transactions SET memo = 'x' WHERE id = $1", [a.expenseId]));
    expect(updated.rowCount).toBe(0);
    const memo = await asA(async (db) => (await db.query('SELECT memo FROM fin.transactions WHERE id = $1', [a.expenseId])).rows[0].memo);
    expect(memo).toBeNull();
  });

  test("B can't insert rows into A's workspace", async () => {
    await rejectsWith(
      '42501',
      asB((db) =>
        db.query(`INSERT INTO fin.payees (id, workspace_id, name, normalized_name) VALUES ($1, $2, 'x', 'x')`, [uuidv7(), a.context.workspaceId]),
      ),
    );
  });

  test("B can't post to A's account or category, even knowing their ids (BR-02.3)", async () => {
    await rejectsWith('23503', asB((db) => rawTransaction(db, b, 'expense', '2026-03-11', [[b.current, -100], [a.food, 100]])));
  });

  test('without a workspace context, nothing is visible', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE fin_app');
      const result = await client.query('SELECT count(*)::int AS n FROM fin.transactions');
      expect(result.rows[0].n).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('protected history and currency (BR-23.2, LR-10, FR-19)', () => {
  test('the currency is locked once transactions exist, and free before that', async () => {
    await rejectsWith('23514', asA((db) => db.query("UPDATE fin.workspaces SET currency = 'USD' WHERE id = $1", [a.context.workspaceId])));
    const empty = { workspaceId: uuidv7(), userId: 'user-empty' };
    await withWorkspace(
      database.pool,
      empty,
      async (db) => {
        await createWorkspace(db, { id: empty.workspaceId, name: 'Empty', currency: 'EUR', timezone: 'Europe/Sofia', ownerUserId: empty.userId });
        const result = await db.query("UPDATE fin.workspaces SET currency = 'USD' WHERE id = $1", [empty.workspaceId]);
        expect(result.rowCount).toBe(1);
        const system = await db.query("SELECT DISTINCT currency FROM fin.ledger_accounts WHERE workspace_id = $1", [empty.workspaceId]);
        expect(system.rows.map((row) => row.currency)).toEqual(['USD']);
      },
      { write: true },
    );
  });

  test('the application role cannot delete transactions or history', async () => {
    await rejectsWith('42501', asA((db) => db.query('DELETE FROM fin.transactions WHERE id = $1', [a.expenseId])));
    await rejectsWith('42501', asA((db) => db.query('DELETE FROM fin.transaction_versions')));
  });

  test('audit events and versions are append-only', async () => {
    await asA((db) =>
      db.query(`INSERT INTO fin.audit_events (id, workspace_id, user_id, event_type) VALUES ($1, $2, $3, 'test')`, [
        uuidv7(),
        a.context.workspaceId,
        a.context.userId,
      ]),
    );
    await rejectsWith('42501', asA((db) => db.query("UPDATE fin.audit_events SET event_type = 'changed'")));
    await rejectsWith('42501', asA((db) => db.query("UPDATE fin.transaction_versions SET changed_by = 'someone'")));
  });

  test('the currency of a posting must match its workspace', async () => {
    await rejectsWith(
      '23503',
      asA(async (db) => {
        const id = uuidv7();
        await db.query(`INSERT INTO fin.transactions (id, workspace_id, txn_date, kind, origin) VALUES ($1, $2, '2026-03-11', 'expense', 'manual')`, [
          id,
          a.context.workspaceId,
        ]);
        await db.query(
          `INSERT INTO fin.postings (id, workspace_id, transaction_id, txn_date, txn_status, ledger_account_id, amount_minor, currency, line_no)
           VALUES ($1, $2, $3, '2026-03-11', 'posted', $4, -100, 'USD', 1)`,
          [uuidv7(), a.context.workspaceId, id, a.current],
        );
      }),
    );
  });
});
