/** Stage 6 on screen: the dashboard's period, drill-downs that add up, and each report, at both widths. */
import type { Page } from '@playwright/test';
import { checkScreen, expect, signedInUser, test, today } from './helpers.ts';

const ORIGIN = 'http://localhost:3100';
const inDays = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shiftMonth = (month: string, by: number) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + by, 1)).toISOString().slice(0, 7);
};
const thisMonth = () => today().slice(0, 7);
const lastMonth = () => shiftMonth(thisMonth(), -1);

async function seed(page: Page) {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  const request = page.context().request;
  const post = async (path: string, data: object) => {
    const response = await request.post(path, { headers: { origin: ORIGIN, 'idempotency-key': `e2e-${crypto.randomUUID()}` }, data });
    expect(response.ok(), `${path} ${await response.text()}`).toBe(true);
    return response.json();
  };
  const current = (await (await request.get('/api/v1/accounts')).json()).items[0].id;
  const categories = (await (await request.get('/api/v1/categories')).json()).items as { id: string; name: string }[];
  const category = (name: string) => categories.find((c) => c.name === name)!.id;
  const expense = (date: string, name: string, amount: number) => post('/api/v1/transactions', { kind: 'expense', date, accountId: current, lines: [{ categoryId: category(name), amount_minor: amount }] });
  await post('/api/v1/transactions', { kind: 'income', date: `${lastMonth()}-02`, accountId: current, lines: [{ categoryId: category('Salary'), amount_minor: 200000 }] });
  await expense(`${lastMonth()}-03`, 'Rent', 60000);
  await expense(`${lastMonth()}-04`, 'Groceries', 4000);
  await expense(today(), 'Groceries', 2500);
  await expense(today(), 'Transport', 1500);
  return { post, current, category };
}

test('the period moves the flows and the net worth date; each figure opens lines that add up to it', async ({ page }) => {
  await seed(page);
  await page.goto('/dashboard');
  await expect(page.getByTestId('expenses')).toHaveText('€40.00');
  await expect(page.getByText('As of today')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Income and spending, last 12 months' })).toBeVisible();
  await checkScreen(page, 'dashboard');

  await page.getByLabel('Period', { exact: true }).selectOption({ label: 'Last month' });
  await expect(page.getByTestId('expenses')).toHaveText('€640.00');
  await expect(page.getByTestId('income')).toHaveText('€2,000.00');
  await expect(page.getByText(/^As of /)).toBeVisible();
  // Safe to Spend stays on today, whatever the period.
  await expect(page.locator('.hero-amount')).toHaveText('€2,320.00');

  await page.getByRole('link', { name: /^Spending/ }).first().click();
  await expect(page.getByTestId('search-total')).toHaveText('€640.00');
  await expect(page.getByText('2 transactions')).toBeVisible();
  await checkScreen(page, 'drill-down');

  await page.goto('/dashboard');
  await page.getByLabel('Period', { exact: true }).selectOption({ label: 'Last month' });
  await expect(page.getByTestId('expenses')).toHaveText('€640.00');
  await page.getByRole('link', { name: /Food/ }).first().click();
  await expect(page.getByTestId('search-total')).toHaveText('€40.00');
});

test('a custom period works, and one back to front changes nothing', async ({ page }) => {
  await seed(page);
  await page.goto('/dashboard');
  await page.getByLabel('Period', { exact: true }).selectOption({ label: 'Custom' });
  await page.getByLabel('From', { exact: true }).fill(`${lastMonth()}-01`);
  await page.getByLabel('To', { exact: true }).fill(`${lastMonth()}-03`);
  await expect(page.getByTestId('expenses')).toHaveText('€600.00');
  await page.getByLabel('From', { exact: true }).fill(`${thisMonth()}-28`);
  await expect(page.getByTestId('expenses')).toHaveText('€600.00');
});

test('each report shows its figures in a table, at both widths', async ({ page }) => {
  await seed(page);
  await page.goto('/reports');
  const report = page.getByLabel('Report', { exact: true });
  await expect(page.getByRole('img', { name: 'Income and spending by month' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Total/ })).toContainText('€680.00');
  await checkScreen(page, 'income report');

  await report.selectOption({ label: 'Spending by category' });
  await page.getByLabel('From', { exact: true }).fill(`${lastMonth()}-01`);
  await page.getByLabel('To', { exact: true }).fill(`${thisMonth()}-28`);
  await expect(page.getByTestId('category-total')).toHaveText('€680.00');
  await expect(page.getByRole('link', { name: /Groceries/ })).toContainText('€65.00');
  await checkScreen(page, 'category report');
  await page.getByRole('link', { name: /Groceries/ }).click();
  await expect(page.getByTestId('search-total')).toHaveText('€65.00');
  await page.goBack();

  await report.selectOption({ label: 'Compare two periods' });
  await page.getByLabel('Period A from').fill(`${lastMonth()}-01`);
  await page.getByLabel('Period A to').fill(`${lastMonth()}-28`);
  await page.getByLabel('Period B from').fill(`${thisMonth()}-01`);
  await page.getByLabel('Period B to').fill(`${thisMonth()}-28`);
  await expect(page.getByRole('row', { name: /^Spending/ })).toContainText('−93.8 %');
  await expect(page.getByRole('row', { name: /Transport/ })).toContainText('New');
  await checkScreen(page, 'comparison');

  await report.selectOption({ label: 'Budget against actual' });
  await expect(page.getByText('All spending')).toBeVisible();
  await checkScreen(page, 'budget report');

  await report.selectOption({ label: 'Net worth over time' });
  await expect(page.getByRole('img', { name: 'Net worth over time' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '€2,320.00' }).first()).toBeVisible();
  await checkScreen(page, 'net worth report');
});

test('the projection has two lines and names its lowest point; a report downloads as a file', async ({ page }) => {
  const { post, current, category } = await seed(page);
  await post('/api/v1/rules', { name: 'Big bill', kind: 'expense', accountId: current, lines: [{ ledgerAccountId: category('Household'), amount_minor: 300000 }], frequency: 'once', startDate: inDays(5) });
  await page.goto('/reports?tab=projection');
  await expect(page.getByRole('img', { name: 'Projection' })).toBeVisible();
  await expect(page.getByText(/below zero/)).toBeVisible();
  await expect(page.getByText(/Lowest point: −€680.00/)).toBeVisible();
  await checkScreen(page, 'projection');

  await page.goto('/reports');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download as CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('income-expenses.csv');
});
