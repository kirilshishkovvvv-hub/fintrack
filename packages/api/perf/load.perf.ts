/**
 * NFR-03 and AC-14.3, measured: dashboard p95 < 1.5 s, reports p95 < 3 s and a save p95 < 500 ms
 * at 50,000 transactions, and at 100,000 because Stage 2 (X-4) designs for that figure.
 * Run with `npm run perf`. It takes minutes, so it isn't part of `npm test`.
 * The times are for this machine and the embedded database, with one user at a time. The load
 * test against real infrastructure, with many users, belongs to Stage 8.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { build, type Transaction } from '@fintrack/domain';
import { insertTransactionsBulk, uuidv7, withWorkspace } from '@fintrack/db';
import { key, startHarness, verifiedUser, type Client, type Harness } from '../test/harness.ts';

let harness: Harness;
let client: Client;
let workspaceId: string;
let userId: string;
let accounts: string[] = [];
let categories: string[] = [];
let inserted = 0;

const CHUNK = 2000;
const RUNS = 20;
const results: { size: number; name: string; p50: number; p95: number; limit: number | null }[] = [];

beforeAll(async () => {
  harness = await startHarness();
  client = await verifiedUser(harness, 'perf@example.com');
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'Perf', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const row = await harness.database.pool.query('SELECT user_id, workspace_id FROM fin.memberships LIMIT 1');
  userId = row.rows[0].user_id;
  workspaceId = row.rows[0].workspace_id;
  const all = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; kind: string }[];
  categories = all.filter((category) => category.kind === 'expense').map((category) => category.id);
  for (const [name, type] of [['Current', 'current'], ['Cash', 'cash'], ['Savings', 'savings'], ['Card', 'card']] as const) {
    const created = await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: '2016-01-01', openingAmount_minor: 100000 } });
    accounts.push(created.body.id);
  }
  const income = all.find((category) => category.kind === 'income')!.id;
  const month = new Date().toISOString().slice(0, 7);
  for (const category of categories.slice(0, 8)) await client.call('PUT', `/api/v1/budgets/${category}/${month}`, { key: key(), body: { limit_minor: 50000 } });
  const today = new Date().toISOString().slice(0, 10);
  await client.call('POST', '/api/v1/rules', { key: key(), body: { name: 'Salary', kind: 'income', accountId: accounts[0], lines: [{ ledgerAccountId: income, amount_minor: 200000 }], frequency: 'monthly_day', startDate: today, isPayday: true, payer: 'ACME' } });
  for (const name of ['Rent', 'Phone', 'Power', 'Water']) {
    await client.call('POST', '/api/v1/rules', { key: key(), body: { name, kind: 'expense', accountId: accounts[0], lines: [{ ledgerAccountId: categories[0], amount_minor: 5000 }], frequency: 'monthly_day', startDate: today } });
  }
  const goal = await client.call('POST', '/api/v1/goals', { key: key(), body: { name: 'Holiday', funding: 'virtual', target_minor: 500000 } });
  await client.call('POST', `/api/v1/goals/${goal.body.id}/allocations`, { key: key(), body: { operation: 'allocate', accountId: accounts[2], amount_minor: 1000 } });
}, 300_000);

afterAll(async () => {
  console.table(results);
  await harness?.stop();
});

/** Ten years of ordinary activity: a date for each row, spread evenly, on several accounts. */
function row(index: number, total: number): { tx: Transaction; description: string } {
  const start = Date.UTC(2016, 0, 2);
  const span = Date.now() - 2 * 86_400_000 - start;
  const date = new Date(start + Math.floor((index / total) * span)).toISOString().slice(0, 10);
  const category = categories[index % categories.length]!;
  const accountId = accounts[index % 7 === 0 ? 3 : index % 3 === 0 ? 1 : 0]!;
  const lines = index % 5 === 0 ? [{ categoryId: category, amount: 1000 + (index % 900) }, { categoryId: categories[(index + 1) % categories.length]!, amount: 500 }] : [{ categoryId: category, amount: 1000 + (index % 900) }];
  return { tx: build.expense({ id: uuidv7(), date, accountId, lines }), description: `Shop number ${index % 500}` };
}

async function growTo(size: number, total: number) {
  while (inserted < size) {
    const items = Array.from({ length: Math.min(CHUNK, size - inserted) }, (_, offset) => row(inserted + offset, total));
    await withWorkspace(harness.database.pool, { workspaceId, userId }, (db) => insertTransactionsBulk(db, workspaceId, items, { origin: 'import', userId }), { write: true });
    inserted += items.length;
  }
  await harness.database.pool.query('ANALYZE');
}

async function measure(size: number, name: string, limit: number | null, run: () => Promise<{ status: number }>) {
  const times: number[] = [];
  for (let attempt = 0; attempt < RUNS; attempt += 1) {
    const started = performance.now();
    const result = await run();
    times.push(performance.now() - started);
    expect(result.status, name).toBeLessThan(300);
  }
  times.sort((a, b) => a - b);
  const entry = { size, name, p50: Math.round(times[Math.floor(RUNS / 2)]!), p95: Math.round(times[Math.ceil(RUNS * 0.95) - 1]!), limit };
  results.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

async function measureAll(size: number) {
  const get = (path: string) => () => client.call('GET', path);
  const list = [
    await measure(size, 'dashboard', 1500, get('/api/v1/dashboard')),
    await measure(size, 'dashboard, previous year', 1500, get(`/api/v1/dashboard?from=${Number(today().slice(0, 4)) - 1}-01-01&to=${Number(today().slice(0, 4)) - 1}-12-31`)),
    await measure(size, 'safe to spend', 1500, get('/api/v1/safe-to-spend')),
    await measure(size, 'report: income and expenses', 3000, get(`/api/v1/reports/income-expenses?from=${Number(today().slice(0, 4)) - 2}-01&to=${today().slice(0, 7)}`)),
    await measure(size, 'report: categories', 3000, get(`/api/v1/reports/categories?from=${Number(today().slice(0, 4)) - 1}-01-01&to=${today()}`)),
    await measure(size, 'report: net worth', 3000, get(`/api/v1/reports/net-worth?from=${Number(today().slice(0, 4)) - 2}-01&to=${today().slice(0, 7)}`)),
    await measure(size, 'report: comparison', 3000, get(`/api/v1/reports/comparison?aFrom=${Number(today().slice(0, 4)) - 2}-01-01&aTo=${Number(today().slice(0, 4)) - 2}-12-31&bFrom=${Number(today().slice(0, 4)) - 1}-01-01&bTo=${Number(today().slice(0, 4)) - 1}-12-31`)),
    await measure(size, 'report: budget vs actual', 3000, get(`/api/v1/budgets?month=${today().slice(0, 7)}`)),
    await measure(size, 'activity, this month', 3000, get(`/api/v1/transactions?from=${monthStart()}&to=${today()}&limit=50`)),
    await measure(size, 'search, all time, by text', 3000, get('/api/v1/transactions?q=number%20123&limit=50')),
    await measure(size, 'accounts', 1500, get('/api/v1/accounts')),
    await measure(size, 'save an expense', 500, () =>
      client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: today(), accountId: accounts[0], lines: [{ categoryId: categories[9], amount_minor: 100 }] } }),
    ),
  ];
  return list;
}

test('at 50,000 transactions, NFR-03 holds', async () => {
  await growTo(50_000, 100_000);
  const list = await measureAll(50_000);
  for (const entry of list) if (entry.limit !== null) expect(entry.p95, entry.name).toBeLessThan(entry.limit);
}, 1_800_000);

test('at 100,000 transactions (X-4), it still holds', async () => {
  await growTo(100_000, 100_000);
  const list = await measureAll(100_000);
  for (const entry of list) if (entry.limit !== null) expect(entry.p95, entry.name).toBeLessThan(entry.limit);
}, 1_800_000);
