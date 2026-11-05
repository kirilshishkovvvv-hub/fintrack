/** Editing accounts and opening balances (FR-03, E-03), categories (FR-05), workspace settings and consents. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { key, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;

async function setUp(openingDate = '2026-02-01') {
  const client = await verifiedUser(harness, `settings-${++counter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'P', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string; parentId: string | null; version: number; kind: string }[];
  const category = (name: string) => categories.find((c) => c.name === name)!;
  const account = async (name: string, type = 'current', opening = 100000) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate, openingAmount_minor: opening } })).body.id as string;
  const detail = async (id: string) => (await client.call('GET', `/api/v1/accounts/${id}`)).body;
  const patch = async (id: string, body: object) => client.call('PATCH', `/api/v1/accounts/${id}`, { headers: { 'if-match': String((await detail(id)).version) }, body });
  const opening = async (id: string, body: object) => client.call('POST', `/api/v1/accounts/${id}/opening`, { headers: { 'if-match': String((await detail(id)).version) }, body });
  const expense = (date: string, accountId: string, amount: number) =>
    client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date, accountId, lines: [{ categoryId: category('Transport').id, amount_minor: amount }] } });
  const audited = async (type: string, id: string) => (await harness.database.pool.query('SELECT 1 FROM fin.audit_events WHERE event_type = $1 AND object_id = $2', [type, id])).rowCount;
  return { client, category, account, detail, patch, opening, expense, audited };
}

describe('editing an account (BR-03.1, BR-03.6, BR-03.7)', () => {
  test('name, optional fields and a type within the class change; the balance does not', async () => {
    const { account, patch, detail, audited } = await setUp();
    const id = await account('Current');
    const changed = await patch(id, { name: 'Main', type: 'savings', spendable: false, institution: 'DSK', notes: 'Salary goes here' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ name: 'Main', type: 'savings', class: 'cash', spendable: false, institution: 'DSK', notes: 'Salary goes here', balance_minor: 100000 });
    expect(await audited('account.updated', id)).toBe(1);
    expect((await patch(id, { institution: null })).body.institution).toBeNull();
    expect((await detail(id)).notes).toBe('Salary goes here');
  });

  test('a type in another class, spendable outside cash, and card fields on other accounts are refused', async () => {
    const { account, patch } = await setUp();
    const current = await account('Current');
    const card = await account('Card', 'card', 0);
    expect((await patch(current, { type: 'card' })).status).toBe(422);
    expect((await patch(card, { type: 'current' })).status).toBe(422);
    expect((await patch(card, { spendable: true })).status).toBe(422);
    expect((await patch(current, { cardReserve: true })).status).toBe(422);
    expect((await patch(current, { creditLimit_minor: 100 })).status).toBe(422);
  });

  test('a card keeps its limit and reserve; turning it into a loan clears both', async () => {
    const { account, patch } = await setUp();
    const card = await account('Card', 'card', 0);
    expect((await patch(card, { creditLimit_minor: 200000 })).body).toMatchObject({ creditLimit_minor: 200000, cardReserve: true });
    expect((await patch(card, { type: 'loan' })).body).toMatchObject({ type: 'loan', creditLimit_minor: null, cardReserve: false });
  });

  test('an account dedicated to a goal cannot become spendable (BR-03.7)', async () => {
    const { client, account, patch } = await setUp();
    const id = await account('Saved', 'savings');
    const created = await client.call('POST', '/api/v1/goals', { key: key(), body: { name: 'House', funding: 'dedicated', accountIds: [id] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await patch(id, { spendable: true })).status).toBe(422);
  });

  test('a stale version is refused, and accounts are listed in the chosen order', async () => {
    const { client, account, detail } = await setUp();
    const a = await account('A');
    const b = await account('B');
    const c = await account('C');
    const version = (await detail(a)).version;
    await client.call('PATCH', `/api/v1/accounts/${a}`, { headers: { 'if-match': String(version) }, body: { name: 'A2' } });
    expect((await client.call('PATCH', `/api/v1/accounts/${a}`, { headers: { 'if-match': String(version) }, body: { name: 'A3' } })).body.code).toBe('VERSION_CONFLICT');
    const names = async () => (await client.call('GET', '/api/v1/accounts')).body.items.map((item: any) => item.name);
    expect(await names()).toEqual(['A2', 'B', 'C']);
    await client.call('POST', '/api/v1/accounts/order', { body: { ids: [c, a, b] } });
    expect(await names()).toEqual(['C', 'A2', 'B']);
    await account('D');
    expect((await names()).at(-1)).toBe('D');
  });

  test('another user cannot read, change or reorder it', async () => {
    const owner = await setUp();
    const id = await owner.account('Mine');
    const other = await setUp();
    expect((await other.client.call('GET', `/api/v1/accounts/${id}`)).status).toBe(404);
    expect((await other.client.call('PATCH', `/api/v1/accounts/${id}`, { headers: { 'if-match': '1' }, body: { name: 'x' } })).status).toBe(404);
    expect((await other.client.call('POST', `/api/v1/accounts/${id}/opening`, { headers: { 'if-match': '1' }, body: { openingAmount_minor: 1 } })).status).toBe(404);
    expect((await other.client.call('POST', '/api/v1/accounts/order', { body: { ids: [id] } })).status).toBe(404);
  });
});

describe('E-03: editing an opening balance or date', () => {
  const at = '2026-10-31';

  test('the balance shifts by the difference; Income and Expenses never change; one transaction stays', async () => {
    const { client, account, opening, detail, expense, audited } = await setUp();
    const id = await account('Current', 'current', 100000);
    await expense('2026-03-01', id, 2500);
    const before = (await client.call('GET', `/api/v1/summary?at=${at}`)).body;

    const changed = await opening(id, { openingAmount_minor: 130000 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ openingAmount_minor: 130000, balance_minor: 127500 });
    expect(await audited('account.opening_changed', id)).toBe(1);

    const after = (await client.call('GET', `/api/v1/summary?at=${at}`)).body;
    expect(after.netWorth_minor - before.netWorth_minor).toBe(30000);
    const list = (await client.call('GET', `/api/v1/transactions?accountId=${id}&kind=opening_balance`)).body;
    expect(list.count).toBe(1);
    expect(list.total_minor).toBe(130000);
    expect((await client.call('GET', `/api/v1/transactions?accountId=${id}&kind=expense`)).body.total_minor).toBe(-2500);
    expect((await detail(id)).balance_minor).toBe(127500);
  });

  test('a liability takes the amount owed, as at creation (BR-03.3)', async () => {
    const { account, opening } = await setUp();
    const loan = await account('Loan', 'loan', 500000);
    expect((await opening(loan, { openingAmount_minor: 450000 })).body).toMatchObject({ openingAmount_minor: 450000, balance_minor: 450000 });
  });

  test('0 voids it, and a later amount brings the same transaction back; one created at 0 gets one', async () => {
    const { client, account, opening } = await setUp();
    const id = await account('Current', 'current', 5000);
    const zero = await opening(id, { openingAmount_minor: 0 });
    expect(zero.status, JSON.stringify(zero.body)).toBe(200);
    expect(zero.body.balance_minor).toBe(0);
    const voided = (await client.call('GET', `/api/v1/transactions?accountId=${id}`)).body;
    expect(voided.items.map((tx: any) => tx.status)).toEqual(['voided']);
    const back = await opening(id, { openingAmount_minor: 7000 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.balance_minor).toBe(7000);
    const list = (await client.call('GET', `/api/v1/transactions?accountId=${id}`)).body;
    expect(list.items.map((tx: any) => [tx.id, tx.status])).toEqual([[voided.items[0].id, 'posted']]);

    const empty = await account('Empty', 'current', 0);
    expect((await opening(empty, { openingAmount_minor: 300 })).body.balance_minor).toBe(300);
  });

  test('LR-04: not later than a transaction (even a voided one), not in the future; earlier works and allows older entries', async () => {
    const { client, account, opening, detail, expense } = await setUp('2026-02-01');
    const id = await account('Current');
    const made = (await expense('2026-03-01', id, 100)).body;
    const late = await opening(id, { openingDate: '2026-03-02' });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('OPENING_DATE_TOO_LATE');
    await client.call('POST', `/api/v1/transactions/${made.id}/void`, { key: key() });
    expect((await opening(id, { openingDate: '2026-03-02' })).body.code).toBe('OPENING_DATE_TOO_LATE');
    expect((await opening(id, { openingDate: '2999-01-01' })).status).toBe(422);

    expect((await opening(id, { openingDate: '2026-02-20' })).body.openingDate).toBe('2026-02-20');
    expect((await expense('2026-02-10', id, 100)).status).toBe(422);
    const earlier = await opening(id, { openingDate: '2026-01-15' });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect((await expense('2026-02-10', id, 100)).status).toBe(201);
    expect((await detail(id)).openingDate).toBe('2026-01-15');
    const tx = (await client.call('GET', `/api/v1/transactions?accountId=${id}&kind=opening_balance`)).body.items[0];
    expect(tx.date).toBe('2026-01-15');
  });

  test('a reconciliation holding it is broken, audited, and so is any later one', async () => {
    const { client, account, opening, detail } = await setUp();
    const id = await account('Current', 'current', 100000);
    const obe = (await client.call('GET', `/api/v1/transactions?accountId=${id}`)).body.items[0];
    const first = await client.call('POST', '/api/v1/reconciliations', { key: key(), body: { accountId: id, statementDate: '2026-03-01', statementBalance_minor: 100000, transactionIds: [obe.id] } });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await client.call('POST', '/api/v1/reconciliations', { key: key(), body: { accountId: id, statementDate: '2026-04-01', statementBalance_minor: 100000, transactionIds: [] } });
    expect((await detail(id)).openingHeldByReconciliation).toBe(true);

    const changed = await opening(id, { openingAmount_minor: 90000 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.openingHeldByReconciliation).toBe(false);
    const rows = (await client.call('GET', `/api/v1/reconciliations?accountId=${id}`)).body.items;
    expect(rows.map((row: any) => row.status)).toEqual(second.status === 201 ? ['broken', 'broken'] : ['broken']);
    const events = await harness.database.pool.query("SELECT 1 FROM fin.audit_events WHERE event_type = 'reconciliation.unlocked' AND object_id = $1", [first.body.id]);
    expect(events.rowCount).toBe(1);
  });

  test('an archived account is refused, and a stale version too', async () => {
    const { client, account, detail } = await setUp();
    const id = await account('Old', 'current', 0);
    const version = (await detail(id)).version;
    await client.call('POST', `/api/v1/accounts/${id}/opening`, { headers: { 'if-match': String(version) }, body: { openingAmount_minor: 100 } });
    expect((await client.call('POST', `/api/v1/accounts/${id}/opening`, { headers: { 'if-match': String(version) }, body: { openingAmount_minor: 200 } })).body.code).toBe('VERSION_CONFLICT');
    const other = await account('Older', 'current', 0);
    await client.call('POST', `/api/v1/accounts/${other}/archive`, { key: key() });
    const blocked = await client.call('POST', `/api/v1/accounts/${other}/opening`, { headers: { 'if-match': String((await detail(other)).version) }, body: { openingAmount_minor: 100 } });
    expect(blocked.body.code).toBe('ARCHIVE_BLOCKED');
  });
});

describe('categories (BR-05.1, BR-05.2, BR-05.5)', () => {
  test('rename, move and reorder; postings keep their amounts and the parent total follows', async () => {
    const { client, category, account, audited } = await setUp();
    const id = await account('Current');
    const groceries = category('Groceries');
    const shopping = category('Shopping');
    await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: '2026-03-01', accountId: id, lines: [{ categoryId: groceries.id, amount_minor: 900 }] } });
    expect((await client.call('GET', `/api/v1/transactions?categoryId=${shopping.id}`)).body.count).toBe(0);

    const moved = await client.call('PATCH', `/api/v1/categories/${groceries.id}`, { headers: { 'if-match': String(groceries.version) }, body: { name: 'Supermarket', parentId: shopping.id } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ name: 'Supermarket', parentId: shopping.id });
    expect(await audited('category.updated', groceries.id)).toBe(1);
    const inShopping = (await client.call('GET', `/api/v1/transactions?categoryId=${shopping.id}&accountId=${id}`)).body;
    expect(inShopping.count).toBe(1);
    expect(inShopping.total_minor).toBe(-900);

    const items = async () => (await client.call('GET', '/api/v1/categories')).body.items as any[];
    const parentsBefore = (await items()).filter((c) => !c.parentId && c.kind === 'expense').map((c) => c.id);
    const reversed = [...parentsBefore].reverse();
    expect((await client.call('POST', '/api/v1/categories/order', { body: { ids: reversed } })).status).toBe(200);
    const after = await items();
    expect(after.filter((c) => !c.parentId && c.kind === 'expense').map((c) => c.id)).toEqual(reversed);
    // A parent is followed straight away by its subcategories.
    const at = after.findIndex((c) => c.id === shopping.id);
    expect(after.slice(at + 1).some((c) => c.parentId === shopping.id)).toBe(true);
    expect(after[at + 1].parentId).toBe(shopping.id);
  });

  test('two levels and one kind; a stale version is refused', async () => {
    const { client, category } = await setUp();
    const food = category('Food');
    const groceries = category('Groceries');
    const salary = category('Salary');
    const patch = (id: string, version: number, body: object) => client.call('PATCH', `/api/v1/categories/${id}`, { headers: { 'if-match': String(version) }, body });
    expect((await patch(food.id, food.version, { parentId: category('Shopping').id })).status).toBe(422); // it has children
    expect((await patch(category('Transport').id, category('Transport').version, { parentId: groceries.id })).status).toBe(422); // third level
    expect((await patch(category('Transport').id, category('Transport').version, { parentId: salary.id })).status).toBe(422); // other kind
    expect((await patch(food.id, food.version, { parentId: food.id })).status).toBe(422);
    expect((await patch(groceries.id, groceries.version, { name: 'A' })).status).toBe(200);
    expect((await patch(groceries.id, groceries.version, { name: 'B' })).body.code).toBe('VERSION_CONFLICT');
    expect((await patch(groceries.id, groceries.version + 1, { parentId: null })).body.parentId).toBeNull();
  });

  test('a new category appears after the others, and can be used straight away', async () => {
    const { client, account } = await setUp();
    const id = await account('Current');
    const created = await client.call('POST', '/api/v1/categories', { key: key(), body: { name: 'Pets', kind: 'expense' } });
    expect(created.status).toBe(201);
    const parents = (await client.call('GET', '/api/v1/categories')).body.items.filter((c: any) => !c.parentId && c.kind === 'expense');
    expect(parents.at(-1).name).toBe('Pets');
    const used = await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: '2026-03-01', accountId: id, lines: [{ categoryId: created.body.id, amount_minor: 100 }] } });
    expect(used.status).toBe(201);
  });
});

describe('workspace settings', () => {
  const settings = async (client: any) => (await client.call('GET', '/api/v1/workspace')).body;
  const patch = async (client: any, body: object) => client.call('PATCH', '/api/v1/workspace', { headers: { 'if-match': String((await settings(client)).version) }, body });

  test('the protected reserve lowers Safe to Spend by exactly its amount; negative is refused', async () => {
    const { client, account, audited } = await setUp();
    await account('Current');
    const before = (await client.call('GET', '/api/v1/summary')).body.safeToSpend.value_minor;
    const changed = await patch(client, { protectedReserve_minor: 25000 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await client.call('GET', '/api/v1/summary')).body.safeToSpend.value_minor).toBe(before - 25000);
    expect((await patch(client, { protectedReserve_minor: -1 })).status).toBe(422);
    expect(await audited('workspace.updated', changed.body.id)).toBe(1);
  });

  test('the time zone must exist; a stale version is refused', async () => {
    const { client } = await setUp();
    expect((await patch(client, { timezone: 'Mars/Olympus' })).status).toBe(422);
    const version = (await settings(client)).version;
    expect((await client.call('PATCH', '/api/v1/workspace', { headers: { 'if-match': String(version) }, body: { timezone: 'Europe/Berlin' } })).body.timezone).toBe('Europe/Berlin');
    expect((await client.call('PATCH', '/api/v1/workspace', { headers: { 'if-match': String(version) }, body: { name: 'x' } })).body.code).toBe('VERSION_CONFLICT');
  });

  test('the currency can change until a transaction exists, then CURRENCY_LOCKED', async () => {
    const { client, account } = await setUp();
    await account('Empty', 'current', 0);
    expect((await settings(client)).currencyLocked).toBe(false);
    const changed = await patch(client, { currency: 'USD' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.currency).toBe('USD');
    await account('Current');
    expect((await settings(client)).currencyLocked).toBe(true);
    const locked = await patch(client, { currency: 'EUR' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('CURRENCY_LOCKED');
  });
});

describe('the marketing consent (Annex L item 6)', () => {
  test('each change is a new record, and only marketing can change', async () => {
    const { client } = await setUp();
    const read = async () => (await client.call('GET', '/api/v1/me/consents')).body.marketing;
    expect(await read()).toBe(false);
    const accepted = await client.call('POST', '/api/v1/me/consents', { key: key(), body: { document: 'marketing', accepted: true } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await read()).toBe(true);
    await client.call('POST', '/api/v1/me/consents', { key: key(), body: { document: 'marketing', accepted: false } });
    expect(await read()).toBe(false);
    expect((await client.call('POST', '/api/v1/me/consents', { key: key(), body: { document: 'terms', accepted: false } })).status).toBe(422);
  });
});
