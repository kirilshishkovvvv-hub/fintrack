/** The dashboard (FR-14) and core reports (FR-15), through the real API and database. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { addDays, monthRange, todayIn } from '@fintrack/domain';
import { key, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

const today = todayIn('Europe/Sofia');
const thisMonth = today.slice(0, 7);
const shift = (month: string, by: number) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + by, 1)).toISOString().slice(0, 7);
};
const lastMonth = shift(thisMonth, -1);
const inLastMonth = `${lastMonth}-15`;
let counter = 0;

async function setUp() {
  const client = await verifiedUser(harness, `reports-${++counter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'P', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((c) => c.name === name)!.id;
  const account = async (name: string, type = 'current', opening = 100000) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: `${shift(thisMonth, -6)}-01`, openingAmount_minor: opening } })).body.id as string;
  const current = await account('Current');
  const post = async (path: string, body: object, expected = 201) => {
    const result = await client.call('POST', path, { key: key(), body });
    expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(expected);
    return result.body;
  };
  const expense = (date: string, name: string, amount: number, accountId = current) => post('/api/v1/transactions', { kind: 'expense', date, accountId, lines: [{ categoryId: category(name), amount_minor: amount }] });
  const income = (date: string, amount: number) => post('/api/v1/transactions', { kind: 'income', date, accountId: current, lines: [{ categoryId: category('Salary'), amount_minor: amount }] });
  const dashboard = async (query = '') => (await client.call('GET', `/api/v1/dashboard${query}`)).body;
  return { client, category, account, current, post, expense, income, dashboard };
}

/** Every line of a search, across pages, with the total the server worked out. */
async function allOf(client: any, query: string) {
  const items: any[] = [];
  let cursor: string | null = null;
  let total = 0;
  do {
    const page: any = (await client.call('GET', `/api/v1/transactions?${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).body;
    items.push(...page.items);
    total = page.total_minor;
    cursor = page.nextCursor;
  } while (cursor);
  return { items, total };
}

describe('the dashboard (FR-14)', () => {
  test('defaults to this month; point-in-time figures say their date; every figure is the canonical one', async () => {
    const { expense, income, account, dashboard, post, current, category } = await setUp();
    const savings = await account('Savings', 'savings', 200000);
    const card = await account('Card', 'card', 0);
    await income(today, 200000);
    await expense(today, 'Food', 5000);
    await expense(today, 'Groceries', 2500, card);
    await expense(inLastMonth, 'Rent', 60000);
    await post('/api/v1/transfers', { date: today, fromAccountId: current, toAccountId: savings, amount_minor: 30000 });
    await post('/api/v1/rules', { name: 'Bill', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Household'), amount_minor: 1000 }], frequency: 'once', startDate: addDays(today, 3) });
    const goal = await post('/api/v1/goals', { name: 'Holiday', funding: 'virtual', target_minor: 100000 });
    await post(`/api/v1/goals/${goal.id}/allocations`, { operation: 'allocate', accountId: savings, amount_minor: 40000 }, 200);

    const d = await dashboard();
    expect(d.period).toEqual(monthRange(thisMonth));
    expect(d.asOf).toBe(today);
    expect(d).toMatchObject({ income_minor: 200000, expenses_minor: 7500, netResult_minor: 192500 });
    // 100,000 + 200,000 − 5,000 − 60,000 − 30,000 on Current; savings 230,000; 2,500 owed.
    expect(d.cashBalance_minor).toBe(205000 + 230000);
    expect(d.assets_minor).toBe(435000);
    expect(d.liabilities_minor).toBe(2500);
    expect(d.netWorth_minor).toBe(432500);
    expect(d.spending).toEqual([expect.objectContaining({ name: 'Food', total_minor: 7500 })]);
    expect(d.upcoming).toMatchObject({ count: 1, overdue: 0, items: [expect.objectContaining({ name: 'Bill' })] });
    expect(d.goals).toEqual([expect.objectContaining({ name: 'Holiday', progress_minor: 40000, target_minor: 100000, shortfall_minor: 0 })]);
    expect(d.recent.map((tx: any) => tx.kind)).not.toContain('opening_balance');
    expect(d.recent.length).toBe(5);
    expect(d.trend).toHaveLength(12);
    expect(d.trend.at(-1)).toMatchObject({ month: thisMonth, income_minor: 200000, expenses_minor: 7500 });
    expect(d.trend.at(-2)).toMatchObject({ month: lastMonth, expenses_minor: 60000 });
    expect(d.hasPayday).toBe(false);
    expect(d.hasPlans).toBe(true);
  });

  test('a past period moves the flows and point-in-time figures; Safe to Spend and Upcoming stay on today', async () => {
    const { expense, dashboard, category, post, current } = await setUp();
    await expense(inLastMonth, 'Rent', 60000);
    await expense(today, 'Food', 5000);
    await post('/api/v1/rules', { name: 'Bill', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Household'), amount_minor: 1000 }], frequency: 'once', startDate: addDays(today, 3) });
    const now = await dashboard();
    const range = monthRange(lastMonth);
    const past = await dashboard(`?from=${range.from}&to=${range.to}`);
    expect(past.asOf).toBe(range.to);
    expect(past.expenses_minor).toBe(60000);
    expect(past.netWorth_minor).toBe(40000);
    expect(now.netWorth_minor).toBe(35000);
    expect(past.safeToSpend.value_minor).toBe(now.safeToSpend.value_minor);
    expect(past.upcoming).toEqual(now.upcoming);
    expect(past.budgets.month).toBe(lastMonth);
  });

  test('a range that includes today has its point-in-time figures as of today, not its end', async () => {
    const { dashboard } = await setUp();
    expect((await dashboard(`?from=${thisMonth}-01&to=${addDays(today, 40)}`)).asOf).toBe(today);
    expect((await (await setUp()).client.call('GET', `/api/v1/dashboard?from=${today}&to=${addDays(today, -1)}`)).status).toBe(422);
  });

  test('AC-14.1: the drill-down lines add up to the widget, across pages; a refund nets off, a void is out', async () => {
    const { client, expense, income, category, post, current, dashboard } = await setUp();
    const range = monthRange(lastMonth);
    await expense(`${lastMonth}-05`, 'Food', 5000);
    await expense(`${lastMonth}-06`, 'Groceries', 3000);
    await expense(`${lastMonth}-07`, 'Rent', 60000);
    await income(`${lastMonth}-08`, 200000);
    await post('/api/v1/transactions', { kind: 'refund', date: `${lastMonth}-09`, accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 1000 }] });
    const voided = await expense(`${lastMonth}-10`, 'Rent', 700);
    await client.call('POST', `/api/v1/transactions/${voided.id}/void`, { key: key() });
    // A transfer is neither income nor spending, so it isn't in the drill-down at all.
    await post('/api/v1/transfers', { date: `${lastMonth}-11`, fromAccountId: current, toAccountId: await setUpSavings(client), amount_minor: 100 });

    const d = await dashboard(`?from=${range.from}&to=${range.to}`);
    const period = `from=${range.from}&to=${range.to}`;
    expect(d.expenses_minor).toBe(67000);
    expect((await allOf(client, `${period}&measure=expense`)).total).toBe(d.expenses_minor);
    expect((await allOf(client, `${period}&measure=income`)).total).toBe(d.income_minor);
    const lines = await allOf(client, `${period}&measure=expense`);
    expect(lines.items.filter((tx) => tx.status === 'posted').reduce((sum, tx) => sum + tx.effect_minor, 0)).toBe(d.expenses_minor);
    for (const row of d.spending) {
      expect((await allOf(client, `${period}&measure=expense&categoryId=${row.categoryId}`)).total, row.name).toBe(row.total_minor);
    }
    expect(d.spending.reduce((sum: number, row: any) => sum + row.total_minor, 0)).toBe(d.expenses_minor);
    // AC-14.2: the same figure as the category report.
    expect((await client.call('GET', `/api/v1/reports/categories?${period}`)).body.total_minor).toBe(d.expenses_minor);
  });

  test('a dashboard read fires a threshold just once; nobody sees another user’s figures', async () => {
    const owner = await setUp();
    await owner.client.call('PUT', `/api/v1/budgets/${owner.category('Food')}/${thisMonth}`, { key: key(), body: { limit_minor: 1000 } });
    await owner.expense(today, 'Food', 900);
    const d = await owner.dashboard();
    expect(d.budgets.items[0]).toMatchObject({ name: 'Food', alerted: [80] });
    await owner.dashboard();
    const events = await harness.database.pool.query('SELECT 1 FROM fin.budget_alert_events WHERE category_id = $1', [owner.category('Food')]);
    expect(events.rowCount).toBe(1);

    const other = await setUp();
    const theirs = await other.dashboard();
    expect(theirs.expenses_minor).toBe(0);
    expect(theirs.budgets.items).toEqual([]);
    expect(theirs.recent).toEqual([]);
    const range = monthRange(thisMonth);
    const report = (await other.client.call('GET', `/api/v1/reports/categories?from=${range.from}&to=${range.to}`)).body;
    expect(report).toEqual({ total_minor: 0, rows: [] });
    expect((await other.client.call('GET', `/api/v1/transactions?measure=expense&categoryId=${owner.category('Food')}`)).body.count).toBe(0);
  });
});

async function setUpSavings(client: any) {
  return (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name: 'Pocket', type: 'savings', openingDate: `${shift(thisMonth, -6)}-01`, openingAmount_minor: 0 } })).body.id;
}

describe('reports (FR-15)', () => {
  test('income and expenses by month, with totals, the average of full months and the savings rate', async () => {
    const { client, expense, income } = await setUp();
    await income(`${lastMonth}-01`, 200000);
    await expense(`${lastMonth}-02`, 'Rent', 60000);
    await expense(today, 'Food', 9000);
    const report = (await client.call('GET', `/api/v1/reports/income-expenses?from=${lastMonth}&to=${thisMonth}`)).body;
    expect(report.rows).toEqual([
      { month: lastMonth, income_minor: 200000, expenses_minor: 60000, netResult_minor: 140000 },
      { month: thisMonth, income_minor: 0, expenses_minor: 9000, netResult_minor: -9000 },
    ]);
    expect(report.total).toEqual({ income_minor: 200000, expenses_minor: 69000, netResult_minor: 131000 });
    expect(report.averageExpenses_minor).toBe(60000);
    expect(report.savingsRateTenths).toBe(655);
    expect((await client.call('GET', `/api/v1/reports/income-expenses?from=${thisMonth}&to=${lastMonth}`)).status).toBe(422);
    expect((await client.call('GET', '/api/v1/reports/income-expenses?from=2020-01&to=2026-01')).status).toBe(422);
    expect((await client.call('GET', '/api/v1/reports/income-expenses?from=nonsense&to=2026-01')).status).toBe(422);
  });

  test('categories roll up to their parent and total Expenses (AC-05.2, AC-15.1); income has its own', async () => {
    const { client, expense, income } = await setUp();
    await expense(today, 'Food', 1000);
    await expense(today, 'Groceries', 2500);
    await expense(today, 'Rent', 60000);
    await income(today, 5000);
    const range = monthRange(thisMonth);
    const report = (await client.call('GET', `/api/v1/reports/categories?from=${range.from}&to=${range.to}`)).body;
    expect(report.total_minor).toBe(63500);
    const housing = report.rows[0];
    expect(housing).toMatchObject({ name: 'Housing', total_minor: 60000, own_minor: 0, children: [expect.objectContaining({ name: 'Rent', total_minor: 60000 })] });
    expect(report.rows[1]).toMatchObject({ name: 'Food', total_minor: 3500, own_minor: 1000, children: [expect.objectContaining({ name: 'Groceries', total_minor: 2500 })] });
    const incomes = (await client.call('GET', `/api/v1/reports/categories?from=${range.from}&to=${range.to}&kind=income`)).body;
    expect(incomes.rows).toEqual([expect.objectContaining({ name: 'Salary', total_minor: 5000 })]);
  });

  test('comparison: absolute and % change, and "new" with a zero base (FR-15)', async () => {
    const { client, expense } = await setUp();
    const a = monthRange(lastMonth);
    const b = monthRange(thisMonth);
    await expense(`${lastMonth}-02`, 'Food', 10000);
    await expense(`${thisMonth}-01`, 'Food', 12500);
    await expense(`${thisMonth}-01`, 'Travel', 3000);
    const report = (await client.call('GET', `/api/v1/reports/comparison?aFrom=${a.from}&aTo=${a.to}&bFrom=${b.from}&bTo=${b.to}`)).body;
    expect(report.totals.find((line: any) => line.key === 'expenses')).toMatchObject({ a_minor: 10000, b_minor: 15500, change_minor: 5500, percentTenths: 550 });
    expect(report.categories.find((line: any) => line.name === 'Travel')).toMatchObject({ a_minor: 0, percentTenths: 'new' });
    expect(report.categories.find((line: any) => line.name === 'Food')).toMatchObject({ change_minor: 2500, percentTenths: 250 });
    expect((await client.call('GET', `/api/v1/reports/comparison?aFrom=${a.to}&aTo=${a.from}&bFrom=${b.from}&bTo=${b.to}`)).status).toBe(422);
  });

  test('net worth over time: the identity holds every month, including an opening balance and an adjustment (AC-15.2)', async () => {
    const { client, expense, income, account, current } = await setUp();
    await account('Loan', 'loan', 500000);
    await income(`${lastMonth}-01`, 200000);
    await expense(`${lastMonth}-02`, 'Rent', 60000);
    const updated = await client.call('POST', `/api/v1/accounts/${current}/balance-update`, { key: key(), body: { date: `${lastMonth}-20`, actual_minor: 250000 } });
    expect(updated.status, JSON.stringify(updated.body)).toBeLessThan(300);
    await expense(today, 'Food', 500);
    const report = (await client.call('GET', `/api/v1/reports/net-worth?from=${shift(thisMonth, -6)}&to=${thisMonth}`)).body;
    expect(report.rows).toHaveLength(7);
    let previous: number | null = null;
    for (const row of report.rows) {
      expect(row.identityHolds, row.month).toBe(true);
      expect(row.netWorth_minor).toBe(row.assets_minor - row.liabilities_minor);
      expect(row.change_minor).toBe(row.netResult_minor + row.otherEffects_minor);
      if (previous !== null) expect(row.netWorth_minor).toBe(previous + row.change_minor);
      previous = row.netWorth_minor;
    }
    expect(report.rows.at(-1).asOf).toBe(today);
    expect(report.rows.at(-1).netWorth_minor).toBe((await client.call('GET', '/api/v1/summary')).body.netWorth_minor);
  });

  test('budget vs actual reconciles with Expenses (AC-07.5)', async () => {
    const { client, category, expense } = await setUp();
    await client.call('PUT', `/api/v1/budgets/${category('Food')}/${thisMonth}`, { key: key(), body: { limit_minor: 10000 } });
    await expense(today, 'Groceries', 4000);
    await expense(today, 'Rent', 60000);
    const report = (await client.call('GET', `/api/v1/budgets?month=${thisMonth}`)).body;
    expect(report.total).toMatchObject({ spent_minor: 4000, unbudgeted_minor: 60000, expenses_minor: 64000 });
  });

  test('a report downloads as CSV, with formula text made inert', async () => {
    const { client, post, current } = await setUp();
    const created = (await client.call('POST', '/api/v1/categories', { key: key(), body: { name: '=SUM(A1)', kind: 'expense' } })).body;
    await post('/api/v1/transactions', { kind: 'expense', date: today, accountId: current, lines: [{ categoryId: created.id, amount_minor: 1234 }] });
    const range = monthRange(thisMonth);
    const response = await harness.handle(new Request(`http://localhost:3000/api/v1/reports/categories?from=${range.from}&to=${range.to}&format=csv`, { headers: { cookie: client.cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const text = await response.text();
    expect(text).toContain("'=SUM(A1)");
    expect(text).toContain('12.34');
  });
});
