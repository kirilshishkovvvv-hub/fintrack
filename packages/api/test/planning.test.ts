/**
 * Stage 5 through the real API and database: rules, occurrences, budgets, goals, Safe to Spend.
 * Today is whatever the clock says, so dates are worked out from it; the fixed-date arithmetic
 * of the golden tests is covered by their own runners.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { addDays, todayIn } from '@fintrack/domain';
import { key, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

const today = todayIn('Europe/Sofia');
const inDays = (days: number) => addDays(today, days);
const OPENED = addDays(today, -60);
let counter = 0;

async function setUp() {
  const client = await verifiedUser(harness, `planning-${++counter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'P', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string; parentId: string | null }[];
  const category = (name: string) => categories.find((c) => c.name === name)!.id;
  const account = async (name: string, type = 'current', opening = 100000, extra: object = {}) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: OPENED, openingAmount_minor: opening, ...extra } })).body.id as string;
  const current = await account('Current');
  const savings = await account('Savings', 'savings', 200000);
  const post = async (path: string, body: object, expected = 201) => {
    const result = await client.call('POST', path, { key: key(), body });
    expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(expected);
    return result.body;
  };
  const once = (name: string, date: string, amount: number, over: object = {}) =>
    post('/api/v1/rules', { name, kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Household'), amount_minor: amount }], frequency: 'once', startDate: date, ...over });
  const occurrences = async (query = '') => (await client.call('GET', `/api/v1/occurrences${query}`)).body.items as any[];
  const occurrenceOf = async (name: string) => (await occurrences(`?to=${inDays(400)}`)).find((o) => o.name === name);
  const sts = async () => (await client.call('GET', '/api/v1/safe-to-spend')).body;
  const expense = (date: string, amount: number, name = 'Household', extra: object = {}) => post('/api/v1/transactions', { kind: 'expense', date, accountId: current, lines: [{ categoryId: category(name), amount_minor: amount }], ...extra });
  const goal = (name: string, extra: object = {}) => post('/api/v1/goals', { name, funding: 'virtual', ...extra });
  const allocate = (id: string, accountId: string, amount: number) => post(`/api/v1/goals/${id}/allocations`, { operation: 'allocate', accountId, amount_minor: amount }, 200);
  return { client, category, account, current, savings, post, once, occurrences, occurrenceOf, sts, expense, goal, allocate };
}

describe('rules and occurrences (FR-08)', () => {
  test('a rule generates once, however often it is asked (AC-08.1), and planned items change no balance (BR-08.9)', async () => {
    const { client, post, current, category, occurrences, sts } = await setUp();
    const before = (await client.call('GET', '/api/v1/summary')).body;
    await post('/api/v1/rules', { name: 'Rent', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Rent'), amount_minor: 60000 }], frequency: 'weekly', startDate: inDays(1) });
    const first = await occurrences(`?to=${inDays(400)}`);
    expect(first.length).toBeGreaterThan(50);
    expect((await occurrences(`?to=${inDays(400)}`)).length).toBe(first.length);
    const rows = await harness.database.pool.query('SELECT rule_id, original_date, count(*) FROM fin.planned_occurrences GROUP BY 1, 2 HAVING count(*) > 1');
    expect(rows.rowCount).toBe(0);
    const after = (await client.call('GET', '/api/v1/summary')).body;
    expect(after.netWorth_minor).toBe(before.netWorth_minor);
    expect(after.assets_minor).toBe(before.assets_minor);
    expect((await sts()).value_minor).toBeLessThan(before.safeToSpend.value_minor);
  });

  test('a payday rule needs income and a payer; a bad template is refused', async () => {
    const { client, current, savings, category } = await setUp();
    const rule = (over: object) => client.call('POST', '/api/v1/rules', { key: key(), body: { name: 'X', kind: 'income', accountId: current, lines: [{ ledgerAccountId: category('Salary'), amount_minor: 100 }], frequency: 'monthly_day', startDate: inDays(1), ...over } });
    expect((await rule({ isPayday: true })).status).toBe(422);
    expect((await rule({ kind: 'expense', isPayday: true, payer: 'ACME', lines: [{ ledgerAccountId: category('Rent'), amount_minor: 100 }] })).status).toBe(422);
    expect((await rule({ lines: [{ ledgerAccountId: category('Rent'), amount_minor: 100 }] })).status).toBe(422);
    expect((await rule({ kind: 'transfer', lines: [{ ledgerAccountId: current, amount_minor: 100 }] })).status).toBe(422);
    expect((await rule({ kind: 'debt_payment', lines: [{ ledgerAccountId: savings, amount_minor: 100 }] })).status).toBe(422);
    expect((await rule({ isPayday: true, payer: 'ACME' })).status).toBe(201);
  });

  test('confirming creates one actual, at the changed amount; the plan leaves STS; a second try is refused (AC-08.3, AC-08.4)', async () => {
    const { client, post, once, occurrenceOf, sts, current } = await setUp();
    await once('Electricity', today, 6000, { amountType: 'estimated' });
    const occurrence = await occurrenceOf('Electricity');
    expect((await sts()).value_minor).toBe(100000 - 6000);
    const confirmed = await post(`/api/v1/occurrences/${occurrence.id}/confirm`, { amount_minor: 7140 }, 200);
    expect(confirmed.transaction).toMatchObject({ description: 'Electricity', origin: 'occurrence' });
    expect((await sts()).value_minor).toBe(100000 - 7140);
    expect((await client.call('GET', '/api/v1/accounts')).body.items.find((a: any) => a.id === current).balance_minor).toBe(100000 - 7140);
    const again = await client.call('POST', `/api/v1/occurrences/${occurrence.id}/confirm`, { key: key(), body: {} });
    expect(again.status).toBe(409);
    expect(await occurrenceOf('Electricity')).toBeUndefined();
  });

  test('GT-44: a void returns the item to Planned, and a restore links it again', async () => {
    const { client, post, once, occurrenceOf, sts } = await setUp();
    await once('Rent', today, 60000);
    const occurrence = await occurrenceOf('Rent');
    const { transaction } = await post(`/api/v1/occurrences/${occurrence.id}/confirm`, {}, 200);
    const paid = (await sts()).value_minor;
    await client.call('POST', `/api/v1/transactions/${transaction.id}/void`, { key: key() });
    expect((await occurrenceOf('Rent')).status).toBe('planned');
    expect((await sts()).value_minor).toBe(paid);
    const restored = await client.call('POST', `/api/v1/transactions/${transaction.id}/restore`, { key: key() });
    expect(restored.body.occurrenceTaken).toBe(false);
    expect(await occurrenceOf('Rent')).toBeUndefined();
    expect((await sts()).value_minor).toBe(paid);
  });

  test('GT-44, the edge: if another transaction took it meanwhile, the restore stays unlinked, and says so', async () => {
    const { client, post, once, occurrenceOf, expense } = await setUp();
    await once('Rent', today, 60000);
    const occurrence = await occurrenceOf('Rent');
    const { transaction } = await post(`/api/v1/occurrences/${occurrence.id}/confirm`, {}, 200);
    await client.call('POST', `/api/v1/transactions/${transaction.id}/void`, { key: key() });
    const other = await expense(today, 60000);
    await post(`/api/v1/occurrences/${occurrence.id}/link`, { transactionId: other.id }, 200);
    const restored = await client.call('POST', `/api/v1/transactions/${transaction.id}/restore`, { key: key() });
    expect(restored.body.occurrenceTaken).toBe(true);
  });

  test('GAP-1: trashing and undoing the create return the item to Planned as well', async () => {
    const { client, post, once, occurrenceOf } = await setUp();
    await once('Rent', today, 60000);
    const occurrence = await occurrenceOf('Rent');
    const { transaction } = await post(`/api/v1/occurrences/${occurrence.id}/confirm`, {}, 200);
    await client.call('POST', `/api/v1/undo/${transaction.undo.token}`, { key: key() });
    expect((await occurrenceOf('Rent')).status).toBe('planned');
  });

  test('GT-67: a matching entry gets a suggestion; linking settles it; a transaction links to one item only (BR-08.4)', async () => {
    const { client, post, once, occurrenceOf, expense, sts } = await setUp();
    await once('Rent', inDays(1), 60000);
    await once('Other', inDays(2), 60000);
    const rent = await occurrenceOf('Rent');
    const other = await occurrenceOf('Other');
    const before = (await sts()).value_minor;
    const entry = await expense(today, 60000);
    expect(entry.suggestions.map((s: any) => s.name)).toEqual(['Rent', 'Other']);
    // Kept separate: the same money counts twice, and the breakdown says so.
    const doubled = await sts();
    expect(doubled.value_minor).toBe(before - 60000);
    expect(doubled.possibleDoubleCounts.map((d: any) => d.name)).toContain('Rent');
    const linked = await post(`/api/v1/occurrences/${rent.id}/link`, { transactionId: entry.id }, 200);
    expect(linked.status).toBe('completed');
    expect((await sts()).value_minor).toBe(before);
    const twice = await client.call('POST', `/api/v1/occurrences/${other.id}/link`, { key: key(), body: { transactionId: entry.id } });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('ALREADY_LINKED');
    // BR-08.8: unlinking leaves the actual where it is.
    const unlinked = await post(`/api/v1/occurrences/${rent.id}/unlink`, {}, 200);
    expect(unlinked.status).toBe('planned');
    expect((await client.call('GET', `/api/v1/transactions/${entry.id}`)).body.status).toBe('posted');
  });

  test('a link on creation is one step; another account does not match (M-1)', async () => {
    const { client, post, once, occurrenceOf, expense, savings, category } = await setUp();
    await once('Rent', today, 60000);
    const rent = await occurrenceOf('Rent');
    const elsewhere = await post('/api/v1/transactions', { kind: 'expense', date: today, accountId: savings, lines: [{ categoryId: category('Household'), amount_minor: 60000 }] });
    expect((await client.call('POST', `/api/v1/occurrences/${rent.id}/link`, { key: key(), body: { transactionId: elsewhere.id } })).status).toBe(422);
    await expense(today, 60000, 'Household', { linkOccurrenceId: rent.id });
    expect(await occurrenceOf('Rent')).toBeUndefined();
  });

  test('GT-30: an edit reaches later, unedited, planned occurrences only; ending a rule cancels what is left', async () => {
    const { client, post, current, category, occurrences } = await setUp();
    const rule = await post('/api/v1/rules', { name: 'Gym', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Household'), amount_minor: 6000 }], frequency: 'weekly', startDate: inDays(1) });
    const all = (await occurrences(`?to=${inDays(60)}`)).filter((o) => o.name === 'Gym');
    const [first, second, third] = all;
    await post(`/api/v1/occurrences/${first.id}/skip`, {}, 200);
    const edited = await client.call('PATCH', `/api/v1/occurrences/${second.id}`, { headers: { 'if-match': String(second.version) }, body: { amount_minor: 7000 } });
    expect(edited.body).toMatchObject({ amount_minor: 7000, isEdited: true });
    const changed = await client.call('PATCH', `/api/v1/rules/${rule.id}`, { headers: { 'if-match': String(rule.version) }, body: { lines: [{ ledgerAccountId: category('Household'), amount_minor: 6500 }], effectiveFrom: today } });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const after = await occurrences(`?to=${inDays(60)}`);
    expect(after.find((o) => o.id === second.id).amount_minor).toBe(7000);
    expect(after.find((o) => o.id === third.id).amount_minor).toBe(6500);
    expect(after.some((o) => o.id === first.id)).toBe(false);
    const stale = await client.call('PATCH', `/api/v1/rules/${rule.id}`, { headers: { 'if-match': String(rule.version) }, body: { name: 'x' } });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    await post(`/api/v1/rules/${rule.id}/end`, {}, 200);
    expect((await occurrences(`?to=${inDays(60)}`)).filter((o) => o.name === 'Gym')).toEqual([]);
  });

  test('AC-11.1: overdue items lead the list whatever the range, and are marked', async () => {
    const { once, occurrences } = await setUp();
    await once('Late', inDays(-10), 1000);
    await once('Soon', inDays(3), 1000);
    await once('Far', inDays(90), 1000);
    const list = await occurrences();
    expect(list.map((o) => [o.name, o.overdue])).toEqual([['Late', true], ['Soon', false]]);
    expect((await occurrences(`?from=${inDays(80)}&to=${inDays(100)}`)).map((o) => o.name)).toEqual(['Late', 'Far']);
  });

  test('an account with planned items or goal money cannot be archived (FR-19)', async () => {
    const { client, account, post, category, goal, allocate } = await setUp();
    const empty = await account('Empty', 'current', 0);
    const rule = await post('/api/v1/rules', { name: 'Fee', kind: 'expense', accountId: empty, lines: [{ ledgerAccountId: category('Household'), amount_minor: 100 }], frequency: 'once', startDate: inDays(5) });
    const blocked = await client.call('POST', `/api/v1/accounts/${empty}/archive`, { key: key() });
    expect(blocked.body.code).toBe('ARCHIVE_BLOCKED');
    await post(`/api/v1/rules/${rule.id}/end`, {}, 200);
    expect((await client.call('POST', `/api/v1/accounts/${empty}/archive`, { key: key() })).status).toBe(200);
    const holding = await account('Holding', 'current', 100);
    const g = await goal('G');
    await allocate(g.id, holding, 50);
    expect((await client.call('POST', `/api/v1/accounts/${holding}/archive`, { key: key() })).status).toBe(409);
  });
});

describe('Safe to Spend (§7, AC-12.2, P8)', () => {
  test('payday sets the window, income is never added, and each term lists its items', async () => {
    const { post, current, savings, category, once, sts, goal, allocate, client } = await setUp();
    await post('/api/v1/rules', { name: 'Salary', kind: 'income', accountId: current, lines: [{ ledgerAccountId: category('Salary'), amount_minor: 200000 }], frequency: 'once', startDate: inDays(10), isPayday: true, payer: 'ACME OOD' });
    await once('Internet', inDays(5), 3000);
    await once('On payday', inDays(10), 2000);
    await once('After payday', inDays(11), 60000);
    await once('Overdue', inDays(-3), 1000);
    const g = await goal('Holiday');
    await allocate(g.id, current, 10000);
    await allocate(g.id, savings, 20000);
    await client.call('PATCH', '/api/v1/workspace', { headers: { 'if-match': String((await client.call('GET', '/api/v1/workspace')).body.version) }, body: { protectedReserve_minor: 5000 } });

    const figures = await sts();
    expect(figures.window).toMatchObject({ kind: 'payday', payday: inDays(10), to: inDays(9), days: 10 });
    expect(figures.eligibleFunds_minor).toBe(100000);
    expect(figures.uco_minor).toBe(4000);
    expect(figures.uga_minor).toBe(10000);
    expect(figures.value_minor).toBe(100000 - 4000 - 5000 - 10000);
    expect(figures.perDay_minor).toBe(Math.floor(81000 / 10));
    expect(figures.ucoItems.map((i: any) => [i.name, i.type]).sort()).toEqual([['Internet', 'planned'], ['Overdue', 'overdue']]);
    expect(figures.dueOnPayday.map((i: any) => i.name)).toEqual(['On payday']);
    expect(figures.ugaItems).toEqual([expect.objectContaining({ type: 'allocation', name: 'Holiday', amount_minor: 10000 })]);
    for (const [items, total] of [[figures.ucoItems, figures.uco_minor], [figures.ugaItems, figures.uga_minor], [figures.elfItems, figures.eligibleFunds_minor]] as const) {
      expect(items.reduce((sum: number, item: any) => sum + item.amount_minor, 0)).toBe(total);
    }
    const summary = (await client.call('GET', '/api/v1/summary')).body;
    expect(summary.safeToSpend.value_minor).toBe(figures.value_minor);
  });

  test('available credit shows for information and never counts (§7.2)', async () => {
    const { client, account, sts } = await setUp();
    const card = await account('Card', 'card', 30000);
    await client.call('PATCH', `/api/v1/accounts/${card}`, { headers: { 'if-match': String((await client.call('GET', `/api/v1/accounts/${card}`)).body.version) }, body: { creditLimit_minor: 100000 } });
    const figures = await sts();
    expect(figures.availableCredit_minor).toBe(70000);
    expect(figures.value_minor).toBe(100000 - 30000);
  });

  test('S-5: the workspace setting turns planned savings transfers off', async () => {
    const { client, post, current, savings, sts } = await setUp();
    await post('/api/v1/rules', { name: 'Save', kind: 'transfer', accountId: current, lines: [{ ledgerAccountId: savings, amount_minor: 30000 }], frequency: 'once', startDate: inDays(5) });
    expect((await sts()).value_minor).toBe(70000);
    await client.call('PATCH', '/api/v1/workspace', { headers: { 'if-match': String((await client.call('GET', '/api/v1/workspace')).body.version) }, body: { stsCountSavingsTransfers: false } });
    expect((await sts()).value_minor).toBe(100000);
  });
});

describe('goals (§8)', () => {
  const goals = async (client: any) => (await client.call('GET', '/api/v1/goals')).body.items as any[];

  test('G-V2: over the unallocated money is refused, naming what is left; no goal changes any ledger figure (AC-09.6)', async () => {
    const { client, current, goal, allocate, sts } = await setUp();
    const before = (await client.call('GET', '/api/v1/summary')).body;
    const a = await goal('A');
    const b = await goal('B');
    await allocate(a.id, current, 80000);
    const refused = await client.call('POST', `/api/v1/goals/${b.id}/allocations`, { key: key(), body: { operation: 'allocate', accountId: current, amount_minor: 30000 } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'ALLOCATION_EXCEEDS_UNALLOCATED', details: { available_minor: 20000 } });
    await allocate(b.id, current, 20000);
    expect((await sts()).value_minor).toBe(0);
    const after = (await client.call('GET', '/api/v1/summary')).body;
    expect([after.assets_minor, after.liabilities_minor, after.netWorth_minor, after.cashBalance_minor]).toEqual([before.assets_minor, before.liabilities_minor, before.netWorth_minor, before.cashBalance_minor]);
  });

  test('GT-49: a dedicated account holds no allocations, stops being spendable, and counts in full', async () => {
    const { client, post, savings, goal, account } = await setUp();
    const spare = await account('Spare', 'current', 5000);
    const house = await post('/api/v1/goals', { name: 'House', funding: 'dedicated', accountIds: [savings, spare] });
    expect(house.progress_minor).toBe(205000);
    const other = await goal('Car');
    const refused = await client.call('POST', `/api/v1/goals/${other.id}/allocations`, { key: key(), body: { operation: 'allocate', accountId: savings, amount_minor: 100 } });
    expect(refused.status).toBe(409);
    const detail = (await client.call('GET', `/api/v1/accounts/${spare}`)).body;
    expect(detail.spendable).toBe(false);
    expect((await client.call('PATCH', `/api/v1/accounts/${spare}`, { headers: { 'if-match': String(detail.version) }, body: { spendable: true } })).status).toBe(422);
    const twice = await client.call('POST', '/api/v1/goals', { key: key(), body: { name: 'Again', funding: 'dedicated', accountIds: [savings] } });
    expect(twice.status).toBe(409);
    // G-D6: unlinking takes the user's choice, and progress follows.
    const unlinked = await post(`/api/v1/goals/${house.id}/unlink`, { accountId: spare, spendable: true }, 200);
    expect(unlinked.progress_minor).toBe(200000);
    expect((await client.call('GET', `/api/v1/accounts/${spare}`)).body.spendable).toBe(true);
    // The database agrees, whatever the application does (G-D3).
    const direct = harness.database.pool.query("UPDATE fin.accounts SET spendable = true WHERE ledger_account_id = $1", [savings]);
    await expect(direct).rejects.toThrow();
  });

  test('GT-52 and GT-50: a shortfall is shared by largest remainder, and moving the allocation closes it', async () => {
    const { client, post, current, savings, goal, allocate, sts } = await setUp();
    const emergency = await goal('Emergency');
    const vacation = await goal('Vacation');
    await allocate(emergency.id, savings, 120000);
    await allocate(vacation.id, savings, 80000);
    const before = (await sts()).value_minor;
    await post('/api/v1/transfers', { date: today, fromAccountId: savings, toAccountId: current, amount_minor: 50000 });
    let rows = await goals(client);
    expect(rows.map((g) => [g.name, g.backed_minor, g.shortfall_minor])).toEqual([['Emergency', 90000, 30000], ['Vacation', 60000, 20000]]);
    expect((await sts()).value_minor).toBe(before);
    const blocked = await client.call('POST', `/api/v1/goals/${vacation.id}/allocations`, { key: key(), body: { operation: 'allocate', accountId: savings, amount_minor: 1 } });
    expect(blocked.status).toBe(409);
    await post(`/api/v1/goals/${emergency.id}/allocations`, { operation: 'move', accountId: savings, toAccountId: current, amount_minor: 50000 }, 200);
    rows = await goals(client);
    expect(rows.map((g) => [g.backed_minor, g.shortfall_minor])).toEqual([[120000, 0], [80000, 0]]);
    expect((await sts()).value_minor).toBe(before);
    const history = (await client.call('GET', `/api/v1/goals/${emergency.id}/history`)).body.items;
    expect(history.map((e: any) => e.event)).toEqual(['move', 'move', 'create']);
  });

  test('G-V3: decrease and release work during a shortfall, not below 0; archive needs all of it released', async () => {
    const { client, post, current, goal, allocate, expense } = await setUp();
    const g = await goal('G');
    await allocate(g.id, current, 90000);
    await expense(today, 50000);
    await post(`/api/v1/goals/${g.id}/allocations`, { operation: 'decrease', accountId: current, amount_minor: 10000 }, 200);
    const below = await client.call('POST', `/api/v1/goals/${g.id}/allocations`, { key: key(), body: { operation: 'decrease', accountId: current, amount_minor: 90000 } });
    expect(below.status).toBe(422);
    expect((await client.call('POST', `/api/v1/goals/${g.id}/archive`, { key: key() })).body.code).toBe('ARCHIVE_BLOCKED');
    await post(`/api/v1/goals/${g.id}/allocations`, { operation: 'release', accountId: current }, 200);
    expect((await post(`/api/v1/goals/${g.id}/archive`, {}, 200)).status).toBe('archived');
  });

  test('GT-65: "use goal money" with the expense is one step; the amount can be lowered; too much saves nothing (AC-09.8)', async () => {
    const { client, current, goal, allocate, expense, sts } = await setUp();
    const g = await goal('Holiday');
    await allocate(g.id, current, 40000);
    const entry = await expense(today, 80000, 'Electronics', { useGoalMoney: { goalId: g.id } });
    expect(entry.released_minor).toBe(40000);
    expect((await sts()).value_minor).toBe(20000);
    const [row] = await goals(client);
    expect(row).toMatchObject({ allocated_minor: 0, used_minor: 40000, state: 'used' });

    const h = await goal('Other');
    await allocate(h.id, current, 10000);
    const count = (await client.call('GET', '/api/v1/transactions')).body.count;
    const tooMuch = await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: today, accountId: current, lines: [{ categoryId: (await client.call('GET', '/api/v1/categories')).body.items[0].id, amount_minor: 100 }], useGoalMoney: { goalId: h.id, amount_minor: 20000 } } });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect((await client.call('GET', '/api/v1/transactions')).body.count).toBe(count);
  });

  test('G-P3: spending recorded first can be connected later', async () => {
    const { post, current, goal, allocate, expense, sts } = await setUp();
    const g = await goal('Holiday');
    await allocate(g.id, current, 40000);
    const entry = await expense(today, 40000);
    expect((await sts()).value_minor).toBe(20000);
    await post(`/api/v1/goals/${g.id}/allocations`, { operation: 'use', accountId: current, transactionId: entry.id }, 200);
    expect((await sts()).value_minor).toBe(60000);
  });

  test('R5, GT-66: a linked payment is covered, and paying it releases the goal money with no jump in STS', async () => {
    const { client, post, current, goal, allocate, once, occurrenceOf, sts } = await setUp();
    const g = await goal('Insurance');
    await allocate(g.id, current, 30000);
    await once('Premium', inDays(5), 36000, { goalId: g.id });
    const covered = await sts();
    expect(covered.uga_minor).toBe(30000);
    expect(covered.uco_minor).toBe(6000);
    expect(covered.value_minor).toBe(64000);
    const [row] = await goals(client);
    expect(row.payments).toEqual([expect.objectContaining({ name: 'Premium', covered_minor: 30000 })]);
    const paid = await post(`/api/v1/occurrences/${(await occurrenceOf('Premium')).id}/confirm`, {}, 200);
    expect(paid.released_minor).toBe(30000);
    expect((await sts()).value_minor).toBe(64000);
    expect((await goals(client))[0]).toMatchObject({ allocated_minor: 0, used_minor: 30000 });
  });

  test('link-payment: one goal per payment; unlinking gives the coverage back', async () => {
    const { post, current, goal, allocate, once, occurrenceOf, sts } = await setUp();
    const g = await goal('Bills');
    await allocate(g.id, current, 10000);
    await once('Bill', inDays(5), 10000);
    const occurrence = await occurrenceOf('Bill');
    expect((await sts()).value_minor).toBe(80000);
    await post(`/api/v1/goals/${g.id}/link-payment`, { occurrenceId: occurrence.id }, 200);
    expect((await sts()).value_minor).toBe(90000);
    await post(`/api/v1/goals/${g.id}/link-payment`, { occurrenceId: occurrence.id, unlink: true }, 200);
    expect((await sts()).value_minor).toBe(80000);
  });

  test('§8.9: converting either way keeps the money counted once', async () => {
    const { client, post, savings, sts } = await setUp();
    const house = await post('/api/v1/goals', { name: 'House', funding: 'dedicated', accountIds: [savings] });
    const before = (await sts()).value_minor;
    const virtual = await post(`/api/v1/goals/${house.id}/convert`, { to: 'virtual' }, 200);
    expect(virtual).toMatchObject({ funding: 'virtual', allocated_minor: 200000, progress_minor: 200000 });
    expect((await sts()).value_minor).toBe(before);
    expect((await client.call('GET', `/api/v1/accounts/${savings}`)).body.spendable).toBe(false);
    const dedicated = await post(`/api/v1/goals/${house.id}/convert`, { to: 'dedicated', accountId: savings }, 200);
    expect(dedicated).toMatchObject({ funding: 'dedicated', allocated_minor: 0, progress_minor: 200000 });
  });

  test('G-T2: a transfer can take its goal money along, as one step; STS stays put', async () => {
    const { client, post, current, savings, goal, allocate, sts } = await setUp();
    const emergency = await goal('Emergency');
    const vacation = await goal('Vacation');
    await allocate(emergency.id, savings, 120000);
    await allocate(vacation.id, savings, 80000);
    const before = (await sts()).value_minor;
    const moved = await post('/api/v1/transfers', { date: today, fromAccountId: savings, toAccountId: current, amount_minor: 50000, moveAllocations: true });
    expect(moved.moved).toBe(50000);
    const rows = await goals(client);
    expect(rows.map((g) => [g.backed_minor, g.shortfall_minor])).toEqual([[120000, 0], [80000, 0]]);
    const emergencyRow = rows.find((g) => g.name === 'Emergency');
    expect(emergencyRow.allocations.map((a: any) => [a.name, a.amount_minor]).sort()).toEqual([['Current', 30000], ['Savings', 90000]]);
    expect((await sts()).value_minor).toBe(before);
  });

  test('G-T2: if the other account cannot hold it, neither the transfer nor the move is saved', async () => {
    const { client, savings, goal, allocate, expense, current } = await setUp();
    const g = await goal('G');
    await allocate(g.id, savings, 200000);
    // The destination already has a shortfall, so it can't take more goal money (G-V2).
    const h = await goal('H');
    await allocate(h.id, current, 100000);
    await expense(today, 100000);
    const count = (await client.call('GET', '/api/v1/transactions')).body.count;
    const refused = await client.call('POST', '/api/v1/transfers', { key: key(), body: { date: today, fromAccountId: savings, toAccountId: current, amount_minor: 50000, moveAllocations: true } });
    expect(refused.status).toBe(409);
    expect((await client.call('GET', '/api/v1/transactions')).body.count).toBe(count);
  });

  test('GT-66 (b): goal money on savings, paid from current: the app offers the move', async () => {
    const { post, current, savings, goal, allocate, once, occurrenceOf, sts } = await setUp();
    const g = await goal('Car insurance');
    await allocate(g.id, savings, 30000);
    await once('Insurance', today, 30000, { goalId: g.id });
    expect((await sts()).value_minor).toBe(100000);
    const paid = await post(`/api/v1/occurrences/${(await occurrenceOf('Insurance')).id}/confirm`, {}, 200);
    expect(paid.moveMoney).toMatchObject({ fromAccountId: savings, toAccountId: current, amount_minor: 30000 });
    expect((await sts()).value_minor).toBe(70000);
    await post('/api/v1/transfers', { date: today, fromAccountId: savings, toAccountId: current, amount_minor: 30000 });
    expect((await sts()).value_minor).toBe(100000);
  });

  test('§8.8: the projection comes with the goal', async () => {
    const { goal } = await setUp();
    const g = await goal('House', { target_minor: 100000, monthly_minor: 10000, targetDate: inDays(400) });
    expect(g.projection).toMatchObject({ remaining: 100000, monthsNeeded: 10, reached: false });
  });
});

describe('budgets (FR-07)', () => {
  const month = today.slice(0, 7);
  const budget = (client: any, categoryId: string, body: object, on = month) => client.call('PUT', `/api/v1/budgets/${categoryId}/${on}`, { key: key(), body });
  const rows = async (client: any, on = month) => (await client.call('GET', `/api/v1/budgets?month=${on}`)).body;

  test('AC-07.1: Spent, Remaining and utilization; a transfer never counts (AC-07.4)', async () => {
    const { client, category, post, current, savings, expense, account } = await setUp();
    const set = await budget(client, category('Food'), { limit_minor: 25000 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    await expense(today, 10000, 'Groceries');
    const card = await account('Card', 'card', 0);
    await post('/api/v1/transactions', { kind: 'expense', date: today, accountId: card, lines: [{ categoryId: category('Food'), amount_minor: 6000 }] });
    await post('/api/v1/transfers', { date: today, fromAccountId: current, toAccountId: savings, amount_minor: 5000 });
    const [row] = (await rows(client)).items;
    expect(row).toMatchObject({ name: 'Food', spent_minor: 16000, remaining_minor: 9000, utilization: '64.0 %', over: false, alerted: [] });
  });

  test('AC-07.2, AC-07.3: crossing 80 % fires once; a refund recomputes and raises nothing new', async () => {
    const { client, category, post, current, expense } = await setUp();
    await budget(client, category('Food'), { limit_minor: 10000 });
    await expense(today, 8000, 'Food');
    await expense(today, 500, 'Food');
    let [row] = (await rows(client)).items;
    expect(row.alerted).toEqual([80]);
    await post('/api/v1/transactions', { kind: 'refund', date: today, accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 6000 }] });
    [row] = (await rows(client)).items;
    expect(row.spent_minor).toBe(2500);
    expect(row.alerted).toEqual([80]);
    await expense(today, 6000, 'Food');
    [row] = (await rows(client)).items;
    expect(row.alerted).toEqual([80]);
    const events = await harness.database.pool.query('SELECT threshold FROM fin.budget_alert_events WHERE category_id = $1', [category('Food')]);
    expect(events.rowCount).toBe(1);
  });

  test('BR-07.2: a parent and its subcategory cannot both have a budget; the database agrees', async () => {
    const { client, category } = await setUp();
    expect((await budget(client, category('Food'), { limit_minor: 100 })).status).toBe(200);
    const child = await budget(client, category('Groceries'), { limit_minor: 100 });
    expect(child.status).toBe(409);
    expect(child.body.code).toBe('BUDGET_BRANCH_CONFLICT');
    await budget(client, category('Food'), { limit_minor: null });
    expect((await budget(client, category('Groceries'), { limit_minor: 100 })).status).toBe(200);
    expect((await budget(client, category('Food'), { limit_minor: 100 })).status).toBe(409);
  });

  test('BR-07.1: a change carries forward, or applies to this month only', async () => {
    const { client, category } = await setUp();
    const later = addDays(`${month}-01`, 40).slice(0, 7);
    const limit = async (on: string) => (await rows(client, on)).items.find((row: any) => row.name === 'Household')?.limit_minor ?? null;
    await budget(client, category('Household'), { limit_minor: 10000 });
    expect(await limit(later)).toBe(10000);
    await budget(client, category('Household'), { limit_minor: 20000, applyForward: false });
    expect(await limit(month)).toBe(20000);
    expect(await limit(later)).toBe(10000);
    await budget(client, category('Household'), { limit_minor: 30000, applyForward: true });
    expect(await limit(later)).toBe(30000);
    await budget(client, category('Household'), { limit_minor: null });
    expect(await limit(month)).toBeNull();
  });

  test('a zero budget with spending is over; a net refund shows 0 %; scheduled stays apart (BR-07.5)', async () => {
    const { client, category, post, current, expense, once } = await setUp();
    await budget(client, category('Household'), { limit_minor: 0 });
    await budget(client, category('Shopping'), { limit_minor: 10000 });
    await expense(today, 500, 'Household');
    await post('/api/v1/transactions', { kind: 'refund', date: today, accountId: current, lines: [{ categoryId: category('Shopping'), amount_minor: 300 }] });
    await once('Later', today, 700, { lines: [{ ledgerAccountId: category('Shopping'), amount_minor: 700 }] });
    const { items } = await rows(client);
    expect(items.find((row: any) => row.name === 'Household')).toMatchObject({ utilization: 'over', over: true });
    const shopping = items.find((row: any) => row.name === 'Shopping');
    expect(shopping).toMatchObject({ utilization: '0.0 %', netRefund: true, scheduled_minor: 700, spent_minor: -300 });
  });

  test('BR-07.13: an overspent budget names the instalment purchase behind it; the full price counts now', async () => {
    const { client, category, account, post } = await setUp();
    const card = await account('Card', 'card', 0);
    await budget(client, category('Electronics'), { limit_minor: 20000 });
    await post('/api/v1/transactions', { kind: 'expense', date: today, accountId: card, description: 'TV', lines: [{ categoryId: category('Electronics'), amount_minor: 60000 }], instalment: true });
    const [row] = (await rows(client)).items;
    expect(row).toMatchObject({ spent_minor: 60000, over: true, instalments: [{ description: 'TV', amount_minor: 60000 }] });
  });

  test('BR-07.3: the overall limit warns and blocks nothing; income categories have no budget', async () => {
    const { client, category } = await setUp();
    await client.call('PUT', `/api/v1/budgets/overall/${month}`, { key: key(), body: { limit_minor: 5000 } });
    await budget(client, category('Household'), { limit_minor: 6000 });
    expect((await rows(client)).overall).toMatchObject({ limit_minor: 5000, budgetsExceedIt: true });
    expect((await budget(client, category('Salary'), { limit_minor: 100 })).status).toBe(422);
  });

  test('archiving a category ends its budget from next month, and keeps this one', async () => {
    const { client, category } = await setUp();
    await budget(client, category('Gifts'), { limit_minor: 1000 });
    await client.call('POST', `/api/v1/categories/${category('Gifts')}/archive`, { key: key() });
    expect((await rows(client)).items.map((row: any) => row.name)).toEqual(['Gifts']);
    const later = addDays(`${month}-01`, 40).slice(0, 7);
    expect((await rows(client, later)).items).toEqual([]);
  });
});

describe('debts and the projection (FR-10, FR-13)', () => {
  test('the overview lists each debt, its change and upcoming payments; credit never counts as money', async () => {
    const { client, account, post, current, category } = await setUp();
    const loan = await account('Loan', 'loan', 800000);
    await post('/api/v1/rules', { name: 'Instalment', kind: 'debt_payment', accountId: current, lines: [{ ledgerAccountId: loan, amount_minor: 32000 }, { ledgerAccountId: category('Interest and fees'), amount_minor: 8000 }], frequency: 'once', startDate: today });
    const figures = (await client.call('GET', '/api/v1/safe-to-spend')).body;
    expect(figures.uco_minor).toBe(40000);
    const occurrence = (await client.call('GET', '/api/v1/occurrences')).body.items[0];
    const debts = (await client.call('GET', `/api/v1/debts?from=${today}&to=${today}`)).body;
    expect(debts.upcoming.map((u: any) => u.name)).toEqual(['Instalment']);
    await post(`/api/v1/occurrences/${occurrence.id}/confirm`, {}, 200);
    const after = (await client.call('GET', `/api/v1/debts?from=${today}&to=${today}`)).body;
    expect(after).toMatchObject({ total_minor: 768000, interestPaid_minor: 8000, upcoming: [] });
    expect(after.items[0]).toMatchObject({ name: 'Loan', owed_minor: 768000, change_minor: -32000 });
  });

  test('the projection has its two lines and lowest point', async () => {
    const { client, once, post, current, category } = await setUp();
    await once('Bill', inDays(2), 90000);
    await post('/api/v1/rules', { name: 'Pay', kind: 'income', accountId: current, lines: [{ ledgerAccountId: category('Salary'), amount_minor: 150000 }], frequency: 'once', startDate: inDays(1) });
    const result = (await client.call('GET', '/api/v1/projection?days=30')).body;
    expect(result.days).toHaveLength(30);
    expect(result.days.at(-1)).toMatchObject({ commitmentsOnly_minor: 10000, withIncome_minor: 160000 });
    expect(result.lowest).toEqual({ date: inDays(2), amount_minor: 10000 });
    expect((await client.call('GET', '/api/v1/projection?days=7')).status).toBe(422);
  });
});

describe('import matches a plan (BR-16.10, GT-37, GT-38)', () => {
  async function importRow(client: any, accountId: string, csv: string) {
    const form = new FormData();
    form.set('file', new File([csv], 'a.csv'));
    form.set('accountId', accountId);
    form.set('settings', JSON.stringify({ encoding: 'utf-8', delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', headerRow: 0, mapping: { date: 0, amount: 1, description: 2 } }));
    const created = await harness.handle(new Request('http://localhost:3000/api/v1/imports', { method: 'POST', headers: { origin: 'http://localhost:3000', cookie: client.cookie, 'idempotency-key': key() }, body: form }));
    expect(created.status).toBe(201);
    return (await created.json()) as any;
  }

  test('the suggestion is only that; accepted, the row completes the plan with its category; undo puts it back', async () => {
    const { client, current, post, category, occurrenceOf, sts } = await setUp();
    await post('/api/v1/rules', { name: 'Rent', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Rent'), amount_minor: 60000 }], frequency: 'once', startDate: inDays(-1) });
    const occurrence = await occurrenceOf('Rent');
    const before = (await sts()).value_minor;
    expect(before).toBe(40000);
    const batch = await importRow(client, current, `Date,Amount,Text\n${today},-600.00,НАЕМ\n`);
    const review = (await client.call('GET', `/api/v1/imports/${batch.id}`)).body;
    expect(review.matchesPlan).toBe(1);
    expect(review.rows[0].planSuggestions).toEqual([expect.objectContaining({ occurrenceId: occurrence.id, name: 'Rent' })]);
    expect((await occurrenceOf('Rent')).status).toBe('planned');

    const decided = await client.call('PATCH', `/api/v1/imports/${batch.id}/rows`, { headers: { 'if-match': String(review.version) }, body: { decisions: [{ rowId: review.rows[0].id, occurrenceId: occurrence.id }] } });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.rows[0]).toMatchObject({ occurrenceId: occurrence.id, categoryId: category('Rent') });
    const confirmed = await client.call('POST', `/api/v1/imports/${batch.id}/confirm`, { key: key(), body: { confirmCurrency: true } });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await occurrenceOf('Rent')).toBeUndefined();
    // One rent payment, not two: the balance reflects it and the plan doesn't count again (AC-08.3).
    expect((await sts()).value_minor).toBe(before);

    const undone = await client.call('POST', `/api/v1/imports/${batch.id}/undo`, { key: key(), body: {} });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect((await occurrenceOf('Rent')).status).toBe('planned');
    expect((await sts()).value_minor).toBe(before);
  });

  test('rejected, the same row counts twice: the difference is the double count matching prevents', async () => {
    const { client, current, post, category, sts } = await setUp();
    await post('/api/v1/rules', { name: 'Rent', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Rent'), amount_minor: 60000 }], frequency: 'once', startDate: inDays(-1) });
    const batch = await importRow(client, current, `Date,Amount,Text\n${today},-600.00,НАЕМ\n`);
    await client.call('POST', `/api/v1/imports/${batch.id}/confirm`, { key: key(), body: { confirmCurrency: true } });
    const figures = await sts();
    expect(figures.value_minor).toBe(40000 - 60000);
    expect(figures.possibleDoubleCounts.map((double: any) => double.name)).toEqual(['Rent']);
  });
});

describe('isolation (FR-02)', () => {
  test("nobody reaches another user's rules, occurrences, goals or budgets", async () => {
    const owner = await setUp();
    await owner.once('Rent', inDays(1), 100);
    const occurrence = await owner.occurrenceOf('Rent');
    const rule = (await owner.client.call('GET', '/api/v1/rules')).body.items[0];
    const goal = await owner.goal('Mine');
    await owner.allocate(goal.id, owner.current, 100);
    await owner.client.call('PUT', `/api/v1/budgets/${owner.category('Food')}/${today.slice(0, 7)}`, { key: key(), body: { limit_minor: 100 } });

    const other = await setUp();
    expect((await other.client.call('GET', '/api/v1/rules')).body.items).toEqual([]);
    expect((await other.client.call('GET', '/api/v1/goals')).body.items).toEqual([]);
    expect(await other.occurrences(`?to=${inDays(400)}`)).toEqual([]);
    expect((await other.client.call('GET', `/api/v1/budgets?month=${today.slice(0, 7)}`)).body.items).toEqual([]);
    const attempts = [
      other.client.call('POST', `/api/v1/occurrences/${occurrence.id}/confirm`, { key: key(), body: {} }),
      other.client.call('POST', `/api/v1/occurrences/${occurrence.id}/skip`, { key: key() }),
      other.client.call('PATCH', `/api/v1/occurrences/${occurrence.id}`, { headers: { 'if-match': '1' }, body: { amount_minor: 1 } }),
      other.client.call('PATCH', `/api/v1/rules/${rule.id}`, { headers: { 'if-match': '1' }, body: { name: 'x' } }),
      other.client.call('POST', `/api/v1/rules/${rule.id}/end`, { key: key() }),
      other.client.call('PATCH', `/api/v1/goals/${goal.id}`, { headers: { 'if-match': '1' }, body: { name: 'x' } }),
      other.client.call('POST', `/api/v1/goals/${goal.id}/archive`, { key: key() }),
      other.client.call('GET', `/api/v1/goals/${goal.id}/history`),
      other.client.call('POST', `/api/v1/goals/${goal.id}/allocations`, { key: key(), body: { operation: 'release', accountId: owner.current } }),
      other.client.call('PUT', `/api/v1/budgets/${owner.category('Food')}/${today.slice(0, 7)}`, { key: key(), body: { limit_minor: 1 } }),
    ];
    for (const result of await Promise.all(attempts)) expect(result.status, JSON.stringify(result.body)).toBe(404);
    const own = await other.goal('Theirs');
    expect((await other.client.call('POST', `/api/v1/goals/${own.id}/allocations`, { key: key(), body: { operation: 'allocate', accountId: owner.current, amount_minor: 1 } })).status).toBe(422);
    expect((await other.client.call('POST', '/api/v1/rules', { key: key(), body: { name: 'x', kind: 'expense', accountId: owner.current, lines: [{ ledgerAccountId: other.category('Food'), amount_minor: 1 }], frequency: 'once', startDate: today } })).status).toBe(422);
  });
});
