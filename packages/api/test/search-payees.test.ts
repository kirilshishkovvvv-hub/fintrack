/** Search and filter (BR-04.5, AC-04.5, GT-59), payees (BR-05.6) and the Uncategorized total (AC-05.3). */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { key, ORIGIN, startHarness, verifiedUser, type Client, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;

async function setUp() {
  const client = await verifiedUser(harness, `search-${++counter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'P', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((c) => c.name === name)!.id;
  const account = async (name: string, type = 'current', opening = 100000) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: '2026-01-01', openingAmount_minor: opening } })).body.id as string;
  const current = await account('Current');
  const post = async (body: object) => {
    const result = await client.call('POST', '/api/v1/transactions', { key: key(), body });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body;
  };
  const expense = (date: string, name: string, amount: number, extra: object = {}) => post({ kind: 'expense', date, accountId: current, lines: [{ categoryId: category(name), amount_minor: amount }], ...extra });
  const search = async (query: string) => (await client.call('GET', `/api/v1/transactions?${query}`)).body;
  return { client, category, account, current, post, expense, search };
}

describe('search and filter (BR-04.5)', () => {
  async function seeded() {
    const s = await setUp();
    const savings = await s.account('Savings', 'savings', 0);
    await s.expense('2026-03-05', 'Groceries', 4560, { description: 'Weekly shop', payee: 'Lidl' });
    await s.expense('2026-03-06', 'Restaurants', 2500, { memo: 'birthday dinner' });
    await s.expense('2026-04-02', 'Transport', 1000, { payee: 'Shell' });
    await s.post({ kind: 'income', date: '2026-03-10', accountId: s.current, lines: [{ categoryId: s.category('Salary'), amount_minor: 200000 }] });
    await s.client.call('POST', '/api/v1/transfers', { key: key(), body: { date: '2026-03-11', fromAccountId: s.current, toAccountId: savings, amount_minor: 30000, description: 'To savings' } });
    return { ...s, savings };
  }
  const titles = (result: any) => result.items.filter((tx: any) => tx.kind !== 'opening_balance').map((tx: any) => tx.kind);

  test('each filter narrows the list; a parent category includes its subcategories', async () => {
    const { search, category, current, savings } = await seeded();
    expect((await search('q=weekly')).count).toBe(1);
    expect((await search('q=BIRTHDAY')).count).toBe(1);
    expect((await search('q=lidl')).count).toBe(1);
    expect((await search('from=2026-04-01&to=2026-04-30')).count).toBe(1);
    expect((await search(`categoryId=${category('Food')}`)).count).toBe(2);
    expect((await search(`categoryId=${category('Groceries')}`)).count).toBe(1);
    expect(titles(await search(`kind=transfer`))).toEqual(['transfer']);
    expect((await search(`accountId=${savings}`)).count).toBe(1);
    expect((await search(`accountId=${current}&minAmount_minor=30000&from=2026-03-01`)).count).toBe(2);
    expect((await search('minAmount_minor=2000&maxAmount_minor=3000')).count).toBe(1);
    expect((await search('origin=system')).count).toBe(1);
    expect((await search('reconciled=true')).count).toBe(0);
  });

  test('AC-04.5: the total equals the sum of the lines, across pages, and voided transactions do not count', async () => {
    const { client, search, current, expense } = await seeded();
    const voided = await expense('2026-03-20', 'Transport', 777);
    await client.call('POST', `/api/v1/transactions/${voided.id}/void`, { key: key() });

    const items: any[] = [];
    let cursor: string | null = null;
    let total = 0;
    do {
      const page: any = await search(`accountId=${current}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.items.length).toBeLessThanOrEqual(2);
      items.push(...page.items);
      cursor = page.nextCursor;
      total = page.total_minor;
    } while (cursor);
    expect(new Set(items.map((tx) => tx.id)).size).toBe(items.length);
    expect(items.map((tx) => tx.date)).toEqual([...items.map((tx) => tx.date)].sort().reverse());
    expect(total).toBe(items.filter((tx) => tx.status === 'posted').reduce((sum, tx) => sum + tx.effect_minor, 0));
    expect(total).toBe((await client.call('GET', '/api/v1/accounts')).body.items.find((a: any) => a.id === current).balance_minor);
  });

  test('across all accounts, a transfer comes to 0, since it is neither income nor spending', async () => {
    const { search } = await seeded();
    const result = await search('kind=transfer');
    expect(result.total_minor).toBe(0);
    expect(result.items[0].effect_minor).toBe(0);
  });

  test('AC-22.4: search ignores case and accents in Latin, Greek and Cyrillic', async () => {
    const { expense, search } = await setUp();
    await expense('2026-03-05', 'Food', 100, { description: 'Café Müller' });
    await expense('2026-03-06', 'Food', 100, { description: 'Καφές στο σπίτι' });
    await expense('2026-03-07', 'Food', 100, { description: 'Кафе Ален мак' });
    for (const [query, count] of [['cafe', 1], ['CAFÉ', 1], ['muller', 1], ['καφες', 1], ['ΚΑΦΈΣ', 1], ['σπιτι', 1], ['кафе', 1], ['АЛЕН', 1], ['nothing', 0]] as const) {
      expect((await search(`q=${encodeURIComponent(query)}`)).count, query).toBe(count);
    }
  });

  test('a bad filter is refused, not ignored', async () => {
    const { client } = await seeded();
    for (const query of ['nonsense=1', 'kind=everything', 'from=2026-04-01&to=2026-03-01', 'limit=99999', 'cursor=abc', 'accountId=not-an-id']) {
      expect((await client.call('GET', `/api/v1/transactions?${query}`)).status, query).toBe(422);
    }
  });

  test('GT-59: another user finds none of it, by text, account, category or payee', async () => {
    const owner = await seeded();
    const lidl = (await owner.client.call('GET', '/api/v1/payees')).body.items.find((p: any) => p.name === 'Lidl').id;
    const other = await setUp();
    const results = [
      await other.search('q=weekly'),
      await other.search(`accountId=${owner.current}`),
      await other.search(`categoryId=${owner.category('Food')}`),
      await other.search(`payeeId=${lidl}`),
    ];
    for (const result of results) expect(result.count).toBe(0);
    expect((await other.client.call('GET', '/api/v1/payees')).body.items).toEqual([]);
    expect((await other.client.call('PATCH', `/api/v1/payees/${lidl}`, { headers: { 'if-match': '1' }, body: { name: 'x' } })).status).toBe(404);
  });
});

describe('payees (BR-05.6)', () => {
  const payees = async (client: Client) => (await client.call('GET', '/api/v1/payees')).body.items as any[];

  test('a name creates the payee once, whatever the spacing or case; its category is learned until one is chosen', async () => {
    const { client, expense, category } = await setUp();
    const first = await expense('2026-03-05', 'Groceries', 100, { payee: 'Lidl' });
    expect(first.payee).toBe('Lidl');
    await expense('2026-03-06', 'Household', 100, { payee: '  LIDL ' });
    let list = await payees(client);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Lidl', defaultCategoryId: category('Household'), defaultIsExplicit: false });

    const set = await client.call('PATCH', `/api/v1/payees/${list[0].id}`, { headers: { 'if-match': String(list[0].version) }, body: { defaultCategoryId: category('Food'), name: 'Lidl Sofia' } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    await expense('2026-03-07', 'Transport', 100, { payee: 'Lidl Sofia' });
    list = await payees(client);
    expect(list[0]).toMatchObject({ name: 'Lidl Sofia', defaultCategoryId: category('Food'), defaultIsExplicit: true });
    expect((await client.call('PATCH', `/api/v1/payees/${list[0].id}`, { headers: { 'if-match': '1' }, body: { name: 'stale' } })).body.code).toBe('VERSION_CONFLICT');
  });

  test('a payee cannot take the name of another; merging is the way', async () => {
    const { client, expense } = await setUp();
    await expense('2026-03-05', 'Food', 100, { payee: 'Lidl' });
    await expense('2026-03-06', 'Food', 100, { payee: 'Billa' });
    const billa = (await payees(client)).find((p) => p.name === 'Billa');
    const renamed = await client.call('PATCH', `/api/v1/payees/${billa.id}`, { headers: { 'if-match': String(billa.version) }, body: { name: ' lidl ' } });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('PAYEE_NAME_TAKEN');
  });

  test('merging moves the transactions and audits it; an edit keeps or changes the payee; undo restores it', async () => {
    const { client, expense, category, current } = await setUp();
    const tx = await expense('2026-03-05', 'Food', 100, { payee: 'Lidl BG' });
    await expense('2026-03-06', 'Food', 200, { payee: 'Lidl' });
    const list = await payees(client);
    const from = list.find((p) => p.name === 'Lidl BG');
    const into = list.find((p) => p.name === 'Lidl');
    const merged = await client.call('POST', `/api/v1/payees/${from.id}/merge`, { key: key(), body: { intoId: into.id } });
    expect(merged.body.moved).toBe(1);
    const read = (await client.call('GET', `/api/v1/transactions/${tx.id}`)).body;
    expect(read.payee).toBe('Lidl');
    expect((await payees(client)).find((p) => p.id === from.id).archived).toBe(true);

    const edited = (await client.call('PATCH', `/api/v1/transactions/${tx.id}`, { headers: { 'if-match': String(read.version) }, body: { kind: 'expense', date: '2026-03-05', accountId: current, payee: 'Billa', lines: [{ categoryId: category('Food'), amount_minor: 100 }] } })).body;
    expect(edited.payee).toBe('Billa');
    const undone = await client.call('POST', `/api/v1/undo/${edited.undo.token}`, { key: key() });
    expect(undone.body.payee).toBe('Lidl');
    expect((await client.call('GET', `/api/v1/transactions/${tx.id}`)).body.payee).toBe('Lidl');
  });

  test('an import file with an "other party" column fills in the payee', async () => {
    const { client, current } = await setUp();
    const form = new FormData();
    form.set('file', new File(['Date,Amount,Text,Party\n2026-03-12,-1.00,X,Kaufland\n'], 'a.csv'));
    form.set('accountId', current);
    form.set('settings', JSON.stringify({ encoding: 'utf-8', delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', headerRow: 0, mapping: { date: 0, amount: 1, description: 2, counterparty: 3 } }));
    const created = await harness.handle(new Request(`${ORIGIN}/api/v1/imports`, { method: 'POST', headers: { origin: ORIGIN, cookie: client.cookie, 'idempotency-key': key() }, body: form }));
    const batch = (await created.json()) as any;
    expect(created.status, JSON.stringify(batch)).toBe(201);
    await client.call('POST', `/api/v1/imports/${batch.id}/confirm`, { key: key(), body: { confirmCurrency: true } });
    expect((await payees(client)).map((p) => p.name)).toEqual(['Kaufland']);
  });
});

describe('the Uncategorized total (AC-05.3)', () => {
  test('appears in the summary only when it is not zero', async () => {
    const { client, current, search } = await setUp();
    const month = '2026-03';
    const figures = () => client.call('GET', `/api/v1/summary?at=${month}-31`).then((r) => r.body.uncategorized);
    expect(await figures()).toEqual([]);
    const form = new FormData();
    form.set('file', new File(['Date,Amount,Text\n2026-03-12,-7.50,MYSTERY\n'], 'a.csv'));
    form.set('accountId', current);
    form.set('settings', JSON.stringify({ encoding: 'utf-8', delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', headerRow: 0, mapping: { date: 0, amount: 1, description: 2 } }));
    const created = await harness.handle(new Request(`${ORIGIN}/api/v1/imports`, { method: 'POST', headers: { origin: ORIGIN, cookie: client.cookie, 'idempotency-key': key() }, body: form }));
    const batch = (await created.json()) as any;
    await client.call('POST', `/api/v1/imports/${batch.id}/confirm`, { key: key(), body: { confirmCurrency: true } });
    const [item] = await figures();
    expect(item).toMatchObject({ kind: 'expense', total_minor: 750 });
    expect((await search(`categoryId=${item.categoryId}`)).count).toBe(1);
  });
});
