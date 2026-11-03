/**
 * Reconciliation, quick balance updates, archiving and merging through the API
 * (FR-18, FR-19, FR-05; GT-40, GT-41, GT-42, GT-45; AC-18.1, AC-18.2, AC-19.3).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { key, startHarness, verifiedUser, type Client, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let userCounter = 0;

/** B0 (§6.1): Current 1,000.00, Cash wallet 100.00 and Savings 2,000.00, all opened on 1 Mar. */
async function setUpB0() {
  const client = await verifiedUser(harness, `reconcile-${++userCounter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((item) => item.name === name)!.id;
  const account = async (name: string, type: string, opening: number) => {
    const result = await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: '2026-03-01', openingAmount_minor: opening } });
    expect(result.status).toBe(201);
    return result.body.id as string;
  };
  const current = await account('Current', 'current', 100000);
  const wallet = await account('Cash wallet', 'cash', 10000);
  const savings = await account('Savings', 'savings', 200000);
  const post = async (body: unknown) => {
    const result = await client.call('POST', '/api/v1/transactions', { key: key(), body });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body;
  };
  const expense = (accountId: string, date: string, name: string, amount: number) =>
    post({ kind: 'expense', date, accountId, lines: [{ categoryId: category(name), amount_minor: amount }] });
  return { client, category, account, current, wallet, savings, post, expense };
}

/** GT-40's March on Current: salary 2,000, rent 600, food 148.83. */
async function gt40Activity(b0: Awaited<ReturnType<typeof setUpB0>>) {
  await b0.post({ kind: 'income', date: '2026-03-10', accountId: b0.current, lines: [{ categoryId: b0.category('Salary'), amount_minor: 200000 }] });
  await b0.expense(b0.current, '2026-03-12', 'Rent', 60000);
  return b0.expense(b0.current, '2026-03-15', 'Food', 14883);
}

const preview = (client: Client, body: unknown) => client.call('POST', '/api/v1/reconciliations/preview', { body });
const finish = (client: Client, body: unknown) => client.call('POST', '/api/v1/reconciliations', { key: key(), body });
const balances = async (client: Client) =>
  Object.fromEntries(((await client.call('GET', '/api/v1/accounts')).body.items as any[]).map((a) => [a.name, a.balance_minor]));

/** Every item the preview offers, ticked, for the given statement. */
async function tickAll(client: Client, accountId: string, statementDate: string, statementBalance_minor: number) {
  const result = await preview(client, { accountId, statementDate, statementBalance_minor, transactionIds: [] });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return { accountId, statementDate, statementBalance_minor, transactionIds: (result.body.items as any[]).filter((i) => !i.automatic).map((i) => i.id) };
}

describe('reconciliation (FR-18)', () => {
  test('GT-40 and AC-18.1: a statement 8.00 below the ledger needs an explicit adjustment of −8.00 to ADJ', async () => {
    const b0 = await setUpB0();
    await gt40Activity(b0);
    const body = await tickAll(b0.client, b0.current, '2026-03-31', 224317);

    const figures = (await preview(b0.client, body)).body;
    expect(figures).toMatchObject({ cleared_minor: 225117, statement_minor: 224317, difference_minor: 800, adjustment_minor: -800 });
    expect((figures.items as any[]).filter((i) => i.automatic).map((i) => i.kind)).toEqual(['opening_balance']);

    const refused = await finish(b0.client, body);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('RECONCILIATION_DIFFERENCE');

    const done = await finish(b0.client, { ...body, adjustment: {} });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body).toMatchObject({ status: 'completed', difference_minor: 0 });
    expect(done.body.transactionIds).toHaveLength(5);

    expect((await balances(b0.client)).Current).toBe(224317);
    const summary = (await b0.client.call('GET', '/api/v1/summary?at=2026-03-31')).body;
    expect(summary.netWorth_minor).toBe(434317);
    expect(summary.safeToSpend.value_minor).toBe(234317);
    const march = (await b0.client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-31')).body.items as any[];
    const onCurrent = march.filter((tx) => tx.lines.some((line: any) => line.ledgerAccountId === b0.current));
    expect(onCurrent.every((tx) => tx.reconciled)).toBe(true);
    const adjustment = march.find((tx) => tx.kind === 'adjustment');
    expect(adjustment.lines.find((line: any) => line.ledgerAccountId === b0.current).amount_minor).toBe(-800);
  });

  test('GT-42 and AC-18.2: a reconciled transaction is locked until an audited unlock, which leaves the reconciliation broken at −10.00', async () => {
    const b0 = await setUpB0();
    const food = await gt40Activity(b0);
    const done = (await finish(b0.client, { ...(await tickAll(b0.client, b0.current, '2026-03-31', 224317)), adjustment: {} })).body;
    const edit = { kind: 'expense', date: '2026-03-15', accountId: b0.current, lines: [{ categoryId: b0.category('Food'), amount_minor: 15883 }] };

    const locked = await b0.client.call('PATCH', `/api/v1/transactions/${food.id}`, { body: edit, headers: { 'if-match': '1' } });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('LOCKED_RECONCILED');
    expect((await b0.client.call('DELETE', `/api/v1/transactions/${food.id}`, { headers: { 'if-match': '1' } })).body.code).toBe('LOCKED_RECONCILED');
    expect((await b0.client.call('POST', `/api/v1/transactions/${food.id}/void`, { key: key() })).body.code).toBe('LOCKED_RECONCILED');
    expect((await b0.client.call('POST', `/api/v1/transactions/${done.adjustmentTransactionId}/void`, { key: key() })).body.code).toBe('LOCKED_RECONCILED');

    const unlocked = await b0.client.call('POST', `/api/v1/reconciliations/${done.id}/unlock`, { key: key() });
    expect(unlocked.status).toBe(200);
    const audit = await harness.database.pool.query("SELECT 1 FROM fin.audit_events WHERE event_type = 'reconciliation.unlocked' AND object_id = $1", [done.id]);
    expect(audit.rowCount).toBe(1);

    expect((await b0.client.call('PATCH', `/api/v1/transactions/${food.id}`, { body: edit, headers: { 'if-match': '1' } })).status).toBe(200);
    expect((await balances(b0.client)).Current).toBe(223317);
    const [broken] = (await b0.client.call('GET', `/api/v1/reconciliations?accountId=${b0.current}`)).body.items;
    expect(broken).toMatchObject({ id: done.id, status: 'broken', difference_minor: -1000 });

    // Redoing it supersedes the broken one.
    const redo = await finish(b0.client, { ...(await tickAll(b0.client, b0.current, '2026-03-31', 223317)) });
    expect(redo.status, JSON.stringify(redo.body)).toBe(201);
    const history = (await b0.client.call('GET', `/api/v1/reconciliations?accountId=${b0.current}`)).body.items.map((r: any) => r.status);
    expect(history.sort()).toEqual(['completed', 'superseded']);
  });

  test('statement dates and ticked items are checked', async () => {
    const b0 = await setUpB0();
    const rent = await b0.expense(b0.current, '2026-03-12', 'Rent', 60000);
    const late = await b0.expense(b0.current, '2026-04-02', 'Food', 1000);
    const other = await b0.expense(b0.wallet, '2026-03-05', 'Food', 1000);
    const base = { accountId: b0.current, statementDate: '2026-03-31', statementBalance_minor: 40000 };
    expect((await preview(b0.client, { ...base, statementDate: '2099-01-01', transactionIds: [] })).status).toBe(422);
    expect((await preview(b0.client, { ...base, statementDate: '2026-02-01', transactionIds: [] })).status).toBe(422);
    const wrong = await preview(b0.client, { ...base, transactionIds: [rent.id, late.id, other.id] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.details.transactionIds.sort()).toEqual([late.id, other.id].sort());

    expect((await finish(b0.client, { ...base, transactionIds: [rent.id] })).status).toBe(201);
    const earlier = await preview(b0.client, { ...base, statementDate: '2026-03-20', transactionIds: [] });
    expect(earlier.status).toBe(409);
    // Already reconciled items are not offered again; April continues from the cleared balance.
    const april = (await preview(b0.client, { ...base, statementDate: '2026-04-30', statementBalance_minor: 39000, transactionIds: [late.id] })).body;
    expect(april.items.map((i: any) => i.id)).toEqual([late.id]);
    expect(april).toMatchObject({ previouslyCleared_minor: 40000, cleared_minor: 39000, difference_minor: 0 });
  });

  test('a transfer reconciled on one account can still be reconciled on the other', async () => {
    const b0 = await setUpB0();
    const transfer = (await b0.client.call('POST', '/api/v1/transfers', {
      key: key(),
      body: { date: '2026-03-05', fromAccountId: b0.current, toAccountId: b0.savings, amount_minor: 50000 },
    })).body;
    expect((await finish(b0.client, { accountId: b0.current, statementDate: '2026-03-31', statementBalance_minor: 50000, transactionIds: [transfer.id] })).status).toBe(201);
    const savings = await finish(b0.client, { accountId: b0.savings, statementDate: '2026-03-31', statementBalance_minor: 250000, transactionIds: [transfer.id] });
    expect(savings.status).toBe(201);
  });

  test('unlocking an earlier reconciliation also unlocks the later ones that build on it', async () => {
    const b0 = await setUpB0();
    const march = await b0.expense(b0.current, '2026-03-12', 'Rent', 60000);
    const april = await b0.expense(b0.current, '2026-04-12', 'Rent', 60000);
    const first = (await finish(b0.client, { accountId: b0.current, statementDate: '2026-03-31', statementBalance_minor: 40000, transactionIds: [march.id] })).body;
    const second = (await finish(b0.client, { accountId: b0.current, statementDate: '2026-04-30', statementBalance_minor: -20000, transactionIds: [april.id] })).body;
    const result = await b0.client.call('POST', `/api/v1/reconciliations/${first.id}/unlock`, { key: key() });
    expect(result.body.items.map((r: any) => r.id).sort()).toEqual([first.id, second.id].sort());
    expect((await b0.client.call('POST', `/api/v1/reconciliations/${first.id}/unlock`, { key: key() })).body.code).toBe('INVALID_STATE');
  });
});

describe('quick balance update (FR-18, GT-41)', () => {
  test('GT-41: the wallet counted at 65.00 and "I spent it" records 35.00 of untracked spending', async () => {
    const b0 = await setUpB0();
    const result = await b0.client.call('POST', `/api/v1/accounts/${b0.wallet}/balance-update`, {
      key: key(),
      body: { date: '2026-03-20', actual_minor: 6500, categoryId: b0.category('Untracked spending') },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.transaction.kind).toBe('adjustment');
    const lines = result.body.transaction.lines.map((line: any) => [line.ledgerAccountId, line.amount_minor]);
    expect(lines).toEqual(expect.arrayContaining([[b0.wallet, -3500], [b0.category('Untracked spending'), 3500]]));
    expect((await balances(b0.client))['Cash wallet']).toBe(6500);
    const summary = (await b0.client.call('GET', '/api/v1/summary?at=2026-03-31')).body;
    expect(summary.netWorth_minor).toBe(306500);
    expect(summary.safeToSpend.value_minor).toBe(106500);
  });

  test('without a category the difference goes to ADJ; no difference posts nothing; cards are reconciled instead', async () => {
    const b0 = await setUpB0();
    const unexplained = await b0.client.call('POST', `/api/v1/accounts/${b0.wallet}/balance-update`, { key: key(), body: { date: '2026-03-20', actual_minor: 6500 } });
    expect(unexplained.body.transaction.kind).toBe('adjustment');
    const same = await b0.client.call('POST', `/api/v1/accounts/${b0.wallet}/balance-update`, { key: key(), body: { date: '2026-03-21', actual_minor: 6500 } });
    expect(same.body.transaction).toBeNull();
    const card = await b0.account('Card', 'card', 0);
    expect((await b0.client.call('POST', `/api/v1/accounts/${card}/balance-update`, { key: key(), body: { date: '2026-03-20', actual_minor: 100 } })).status).toBe(422);
  });

  test('an investment gets a valuation, never income (E-43, LR-12)', async () => {
    const b0 = await setUpB0();
    const investment = await b0.account('Investment', 'investment', 500000);
    const result = await b0.client.call('POST', `/api/v1/accounts/${investment}/balance-update`, { key: key(), body: { date: '2026-03-31', actual_minor: 545000 } });
    expect(result.body.transaction.kind).toBe('valuation');
    expect((await balances(b0.client)).Investment).toBe(545000);
    const asSpending = await b0.client.call('POST', `/api/v1/accounts/${investment}/balance-update`, {
      key: key(),
      body: { date: '2026-03-31', actual_minor: 500000, categoryId: b0.category('Food') },
    });
    expect(asSpending.status).toBe(422);
  });
});

describe('archiving and merging (FR-19, FR-05, GT-45)', () => {
  test('GT-45 (a) and AC-19.3: an account is archived only at a zero balance; history stays and nothing more can be posted to it', async () => {
    const b0 = await setUpB0();
    const old = await b0.account('Old bank', 'current', 1234);
    const blocked = await b0.client.call('POST', `/api/v1/accounts/${old}/archive`, { key: key() });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'ARCHIVE_BLOCKED', details: { balance_minor: 1234 } });

    await b0.client.call('POST', '/api/v1/transfers', { key: key(), body: { date: '2026-03-02', fromAccountId: old, toAccountId: b0.current, amount_minor: 1234 } });
    const archived = await b0.client.call('POST', `/api/v1/accounts/${old}/archive`, { key: key() });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
    expect(await balances(b0.client)).toMatchObject({ Current: 101234, 'Old bank': 0 });
    expect((await b0.client.call('GET', '/api/v1/summary?at=2026-03-31')).body.netWorth_minor).toBe(311234);
    const posting = await b0.client.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'expense', date: '2026-03-05', accountId: old, lines: [{ categoryId: b0.category('Food'), amount_minor: 100 }] },
    });
    expect(posting.status).toBe(422);
    expect((await b0.client.call('POST', `/api/v1/accounts/${old}/unarchive`, { key: key() })).body.archived).toBe(false);
  });

  test('GT-45 (b): merging moves the whole history to the other category; Expenses are unchanged', async () => {
    const b0 = await setUpB0();
    const dining = (await b0.client.call('POST', '/api/v1/categories', { key: key(), body: { name: 'Dining out', kind: 'expense' } })).body.id;
    await b0.expense(b0.current, '2026-03-05', 'Food', 10000);
    const meal = await b0.post({ kind: 'expense', date: '2026-03-06', accountId: b0.current, lines: [{ categoryId: dining, amount_minor: 5000 }] });

    const merged = await b0.client.call('POST', `/api/v1/categories/${dining}/merge`, { key: key(), body: { intoId: b0.category('Food') } });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body).toMatchObject({ movedLines: 1, from: { archived: true } });
    const moved = (await b0.client.call('GET', `/api/v1/transactions/${meal.id}`)).body;
    expect(moved.lines.map((line: any) => line.ledgerAccountId)).toContain(b0.category('Food'));
    expect((await balances(b0.client)).Current).toBe(85000);
    const event = await harness.database.pool.query("SELECT 1 FROM fin.audit_events WHERE event_type = 'category.merged' AND object_id = $1", [dining]);
    expect(event.rowCount).toBe(1);
  });

  test('merges stay within one kind, and parents go only after their subcategories', async () => {
    const b0 = await setUpB0();
    expect((await b0.client.call('POST', `/api/v1/categories/${b0.category('Bonus')}/merge`, { key: key(), body: { intoId: b0.category('Food') } })).status).toBe(422);
    expect((await b0.client.call('POST', `/api/v1/categories/${b0.category('Food')}/merge`, { key: key(), body: { intoId: b0.category('Shopping') } })).body.code).toBe('ARCHIVE_BLOCKED');
    expect((await b0.client.call('POST', `/api/v1/categories/${b0.category('Food')}/archive`, { key: key() })).body.code).toBe('ARCHIVE_BLOCKED');
    expect((await b0.client.call('POST', `/api/v1/categories/${b0.category('Groceries')}/archive`, { key: key() })).body.archived).toBe(true);
  });
});

describe('isolation (GT-59)', () => {
  test("another user can't reconcile, unlock, update, archive or merge someone else's data", async () => {
    const owner = await setUpB0();
    const rent = await owner.expense(owner.current, '2026-03-12', 'Rent', 60000);
    const done = (await finish(owner.client, { accountId: owner.current, statementDate: '2026-03-31', statementBalance_minor: 40000, transactionIds: [rent.id] })).body;
    const intruder = await setUpB0();
    const c = intruder.client;
    expect((await preview(c, { accountId: owner.current, statementDate: '2026-03-31', statementBalance_minor: 0, transactionIds: [] })).status).toBe(404);
    expect((await finish(c, { accountId: intruder.current, statementDate: '2026-03-31', statementBalance_minor: 0, transactionIds: [rent.id] })).status).toBe(422);
    expect((await c.call('POST', `/api/v1/reconciliations/${done.id}/unlock`, { key: key() })).status).toBe(404);
    expect((await c.call('POST', `/api/v1/accounts/${owner.wallet}/balance-update`, { key: key(), body: { date: '2026-03-20', actual_minor: 0 } })).status).toBe(404);
    expect((await c.call('POST', `/api/v1/accounts/${owner.savings}/archive`, { key: key() })).status).toBe(404);
    expect((await c.call('POST', `/api/v1/categories/${owner.category('Food')}/merge`, { key: key(), body: { intoId: intruder.category('Food') } })).status).toBe(404);
    expect((await c.call('GET', '/api/v1/reconciliations')).body.items).toEqual([]);
    const [still] = (await owner.client.call('GET', '/api/v1/reconciliations')).body.items;
    expect(still.status).toBe('completed');
  });
});
