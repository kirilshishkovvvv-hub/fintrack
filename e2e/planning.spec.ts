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

  // Wireframe 1: an item due on payday shows on the dashboard itself, without opening anything.
  await addBill(page, 'Rent on payday', '300', inDays(10));
  await page.goto('/dashboard');
  await expect(page.getByText(/Due on payday: Rent on payday/)).toBeVisible();
  await expect(hero(page)).toHaveText('€1,000.00');
  await expect(page.getByText('Bills and card debt').first()).toBeVisible();
  // §7.10: what the figure leaves out is named, and the salary is never added.
  await page.getByText("How it's calculated").click();
  await expect(page.getByText('Not included in this figure:')).toBeVisible();
  await expect(page.getByText(/Expected income: Salary/)).toBeVisible();
  await checkScreen(page, 'dashboard with the payday line');
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
  await page.getByLabel('Monthly limit', { exact: true }).fill('100');
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

test('one item can change on its own; a split rule keeps its lines; past dates are asked about', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/plan/rules/new');
  await expect(page.getByLabel('Name')).toBeVisible();
  await page.getByLabel('Name').fill('Shop');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByLabel('Amount', { exact: true }).fill('30');
  await page.getByRole('button', { name: 'Split across another category' }).click();
  await page.getByLabel('Line 2: category').selectOption({ label: 'Transport' });
  await page.getByLabel('Line 2: amount').fill('20');
  await page.getByLabel('How often').selectOption({ label: 'Once' });
  await page.getByLabel('Due date').fill(inDays(-3));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/already in the past/)).toBeVisible();
  await checkScreen(page, 'past dates prompt');
  await page.getByRole('button', { name: 'Let me review them' }).click();
  await expect(page.getByRole('heading', { name: 'Overdue' })).toBeVisible();
  await expect(page.getByText('−€50.00')).toBeVisible();

  await page.getByRole('button', { name: 'Change this Shop only' }).click();
  await page.getByLabel('Amount', { exact: true }).fill('55');
  await page.getByRole('button', { name: 'Save this one' }).click();
  await expect(status(page)).toContainText('Shop');
  await expect(page.getByText('−€55.00')).toBeVisible();
  await expect(page.getByText('Changed', { exact: true })).toBeVisible();
});

test('a transfer can take its goal money along; a goal can be edited; a paid item can be unlinked', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  const request = page.context().request;
  const post = (path: string, data: object) => request.post(path, { headers: { origin: 'http://localhost:3100', 'idempotency-key': `e2e-${crypto.randomUUID()}` }, data });
  const savings = await (await post('/api/v1/accounts', { name: 'Savings', type: 'savings', openingDate: '2026-01-01', openingAmount_minor: 100000 })).json();
  const goal = await (await post('/api/v1/goals', { name: 'House', funding: 'virtual', target_minor: 500000 })).json();
  expect((await post(`/api/v1/goals/${goal.id}/allocations`, { operation: 'allocate', accountId: savings.id, amount_minor: 100000 })).ok()).toBe(true);

  await page.goto('/transactions/new');
  await expect(page.getByLabel('Amount')).toBeVisible();
  await page.locator('.segmented label', { hasText: 'Transfer' }).click();
  await page.getByLabel('From', { exact: true }).selectOption({ label: 'Savings' });
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Current' });
  await page.getByLabel('Amount').fill('300');
  await expect(page.getByText('Also move €300.00 of goal money')).toBeVisible();
  await checkScreen(page, 'transfer with goal money');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€1,000.00');

  await page.goto('/goals');
  await expect(page.getByText('€1,000.00 of €5,000.00')).toBeVisible();
  await page.getByRole('button', { name: 'Edit House' }).click();
  await page.locator('[id^=edit-target-]').fill('2000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('€1,000.00 of €2,000.00')).toBeVisible();

  await addBill(page, 'Rent', '100', today());
  await page.getByRole('button', { name: 'Confirm Rent' }).click();
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await expect(status(page)).toContainText('Rent');
  await page.goto('/transactions');
  await page.getByRole('link', { name: /Rent/ }).click();
  await expect(page.getByText(/This paid the planned Rent/)).toBeVisible();
  await page.getByRole('button', { name: 'Unlink from the plan' }).click();
  await expect(status(page)).toContainText('Unlinked');
  await page.goto('/plan');
  await expect(page.getByRole('button', { name: 'Confirm Rent' })).toBeVisible();
});

test('settings: the savings-transfer choice; a loan keeps its details; budgets take an overall limit', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  const request = page.context().request;
  const post = (path: string, data: object) => request.post(path, { headers: { origin: 'http://localhost:3100', 'idempotency-key': `e2e-${crypto.randomUUID()}` }, data });
  const accounts = (await (await request.get('/api/v1/accounts')).json()).items;
  const savings = await (await post('/api/v1/accounts', { name: 'Savings', type: 'savings', openingDate: '2026-01-01', openingAmount_minor: 0 })).json();
  const loan = await (await post('/api/v1/accounts', { name: 'Loan', type: 'loan', openingDate: '2026-01-01', openingAmount_minor: 100 })).json();
  expect((await post('/api/v1/rules', { name: 'Save', kind: 'transfer', accountId: accounts[0].id, lines: [{ ledgerAccountId: savings.id, amount_minor: 30000 }], frequency: 'once', startDate: inDays(2) })).ok()).toBe(true);

  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€700.00');
  await page.goto('/settings/general');
  await page.getByLabel('Count planned transfers to savings as commitments').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(status(page)).toHaveText('Saved.');
  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€1,000.00');

  await page.goto(`/accounts/${loan.id}/edit`);
  await page.getByLabel('Interest rate, % (optional)').fill('5,25');
  await page.getByLabel('Term in months (optional)').fill('60');
  await checkScreen(page, 'loan details');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(status(page)).toHaveText('Saved.');
  await page.reload();
  await expect(page.getByLabel('Interest rate, % (optional)')).toHaveValue('5.25');

  await page.goto('/budgets');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByLabel('Monthly limit', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Add budget' }).click();
  await expect(page.getByText('€0.00 of €100.00 · 0.0 %')).toBeVisible();
  await page.getByLabel('Overall monthly limit (optional)').fill('50');
  await page.getByRole('button', { name: 'Save overall limit' }).click();
  await expect(page.getByText(/add up to more than your overall limit/)).toBeVisible();
});

test('an import row can be accepted as the planned bill; the plan is then done, and the money counted once', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addBill(page, 'Rent', '600', today());
  const request = page.context().request;
  const accounts = (await (await request.get('/api/v1/accounts')).json()).items;
  const created = await request.post('/api/v1/imports', {
    headers: { origin: 'http://localhost:3100', 'idempotency-key': `e2e-${crypto.randomUUID()}` },
    multipart: {
      file: { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from(`Date,Amount,Text\n${today()},-600.00,RENT MARCH\n`) },
      accountId: accounts[0].id,
      settings: JSON.stringify({ encoding: 'utf-8', delimiter: ',', decimalSeparator: '.', dateFormat: 'YYYY-MM-DD', headerRow: 0, mapping: { date: 0, amount: 1, description: 2 } }),
    },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/import/${(await created.json()).id}`);
  const choice = page.getByLabel('This may be a planned item');
  await expect(choice).toBeVisible();
  await checkScreen(page, 'import review with a planned item');
  await choice.selectOption({ index: 1 });
  await expect(choice).not.toHaveValue('');
  await page.getByRole('checkbox').first().check().catch(() => undefined);
  await page.getByRole('button', { name: 'Confirm import' }).click();
  await expect(page.getByRole('button', { name: 'Confirm import' })).toHaveCount(0);
  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€400.00');
  await page.goto('/plan');
  await expect(page.getByRole('button', { name: 'Confirm Rent' })).toHaveCount(0);
});

test('AC-04.4: a future date is refused, and planning it is offered instead', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/transactions/new');
  await page.getByLabel('Amount').fill('50');
  await page.getByLabel('Category').selectOption({ label: 'Household' });
  await page.getByLabel('Date').fill(inDays(3));
  await expect(page.getByText("This hasn't happened yet")).toBeVisible();
  // The date field's own limit stops the save here; the API tests cover the server's refusal.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/transactions\/new/);
  await page.getByRole('link', { name: 'Plan it instead' }).click();
  await expect(page).toHaveURL(/\/plan\/rules\/new/);
});
