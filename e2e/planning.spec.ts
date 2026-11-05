/** Stage 5 on screen: planned items in Safe to Spend, budgets, goal money and matching, at both widths. */
import type { Page } from '@playwright/test';
import { checkScreen, expect, signedInUser, test, today } from './helpers.ts';

const hero = (page: Page) => page.locator('.hero-amount');
const status = (page: Page) => page.locator('main [role=status]');
const inDays = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function addBill(page: Page, name: string, amount: string, date: string) {
  await page.goto('/plan/rules/new');
  await expect(page.getByLabel('Name')).toBeVisible();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByLabel('Amount', { exact: true }).fill(amount);
  await page.getByLabel('How often').selectOption({ label: 'Once' });
  await page.getByLabel('Due date').fill(date);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
}

test('a planned bill lowers Safe to Spend, the breakdown names it, and confirming leaves one payment', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addBill(page, 'Electricity', '60', inDays(2));
  await expect(page.getByText('Electricity')).toBeVisible();
  await checkScreen(page, 'upcoming');

  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€940.00');
  await expect(page.getByText('in the next 30 days')).toBeVisible();
  await page.getByText("How it's calculated").click();
  await expect(page.locator('details').getByText(/Electricity/)).toBeVisible();
  await checkScreen(page, 'dashboard with the breakdown');

  await page.goto('/plan');
  await page.getByRole('button', { name: 'Confirm Electricity' }).click();
  await page.getByLabel('Actual amount').fill('71.40');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await expect(status(page)).toContainText('Electricity');
  await expect(page.getByRole('button', { name: 'Confirm Electricity' })).toHaveCount(0);

  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€928.60');
});

test('a payday rule sets the window; income is never added', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Tell us when you get paid' }).click();
  await expect(page.getByLabel('Name')).toHaveValue('Salary');
  await page.getByLabel('Category').selectOption({ label: 'Salary' });
  await page.getByLabel('Amount', { exact: true }).fill('2000');
  await page.getByLabel('First date').fill(inDays(10));
  await page.getByLabel('Who pays you').fill('ACME OOD');
  await checkScreen(page, 'payday rule form');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);

  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€1,000.00');
  await expect(page.getByText(/Safe to spend until/)).toBeVisible();
  await expect(page.getByText(/a day/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tell us when you get paid' })).toHaveCount(0);
});

test('a typed entry that looks like the plan is offered as a link; linking leaves Safe to Spend as it was', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addBill(page, 'Rent', '600', inDays(1));
  await page.goto('/transactions/new');
  await page.getByLabel('Amount').fill('600');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/looks like your planned Rent/)).toBeVisible();
  await checkScreen(page, 'match prompt');
  await page.getByRole('button', { name: 'Link it' }).click();
  await expect(hero(page)).toHaveText('€400.00');
});

test('kept separate, the possible double count shows in the breakdown, with a way to link it', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addBill(page, 'Rent', '600', inDays(1));
  await page.goto('/transactions/new');
  await page.getByLabel('Amount').fill('600');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Keep separate' }).click();
  await expect(hero(page)).toHaveText('−€200.00');
  await expect(page.getByText(/Shortfall|more to cover/)).toBeVisible();
  await page.getByText("How it's calculated").click();
  await page.getByRole('button', { name: 'Link them' }).click();
  await expect(hero(page)).toHaveText('€400.00');
});

test('budgets show Spent, the state in words, and fire at 80 %', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/budgets');
  await expect(page.getByLabel('Category')).toBeVisible();
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByLabel('Monthly limit').fill('100');
  await page.getByRole('button', { name: 'Add budget' }).click();
  await expect(page.getByText('€0.00 of €100.00 · 0.0 %')).toBeVisible();
  await checkScreen(page, 'budgets');

  await page.goto('/transactions/new');
  await page.getByLabel('Amount').fill('80');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€920.00');

  await page.goto('/budgets');
  await expect(page.getByText(/€80.00 of €100.00 · 80.0 %/)).toBeVisible();
  await expect(page.getByText('Close to the limit')).toBeVisible();
});

test('goal money comes off Safe to Spend; an expense asks about it; too much is refused with the amount left', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).click();
  await page.getByLabel('Name').fill('Holiday');
  await page.getByLabel('Target (optional)').fill('2000');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await expect(status(page)).toContainText('Holiday');

  await page.getByRole('button', { name: 'Set aside money for Holiday' }).click();
  await page.getByLabel('Amount').fill('1200');
  await page.getByRole('button', { name: 'Set aside', exact: true }).click();
  await expect(page.locator('main [role=alert]')).toContainText('not enough');
  await page.getByLabel('Amount').fill('400');
  await page.getByRole('button', { name: 'Set aside', exact: true }).click();
  await expect(page.getByText('€400.00 of €2,000.00')).toBeVisible();
  await checkScreen(page, 'goals');

  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€600.00');

  await page.goto('/transactions/new');
  await page.getByLabel('Amount').fill('300');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await expect(page.getByText('Is this paid from your goal money?')).toBeVisible();
  await checkScreen(page, 'goal money prompt');
  await page.locator('.segmented label', { hasText: 'Holiday' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€600.00');

  await page.goto('/goals');
  await expect(page.getByText('€100.00 of €2,000.00')).toBeVisible();
});

test('debts list what is owed and what is coming', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  const created = await page.context().request.post('/api/v1/accounts', {
    headers: { origin: 'http://localhost:3100', 'idempotency-key': `e2e-${crypto.randomUUID()}` },
    data: { name: 'Loan', type: 'loan', openingDate: '2026-01-01', openingAmount_minor: 500000 },
  });
  expect(created.status()).toBe(201);
  await page.goto('/debts');
  await expect(page.getByRole('link', { name: /Loan/ })).toContainText('€5,000.00');
  await checkScreen(page, 'debts');
});
