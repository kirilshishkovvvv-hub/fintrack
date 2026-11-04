/** Search with its total (BR-04.5, AC-04.5), payees (BR-05.6) and the Uncategorized notice (AC-05.3), on screen. */
import { checkScreen, expect, signedInUser, test, today } from './helpers.ts';

const save = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Save', exact: true }).click();

async function addExpense(page: import('@playwright/test').Page, amount: string, category: string, payee: string) {
  await page.goto('/transactions/new');
  await expect(page.getByLabel('Amount')).toBeVisible();
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('Category').selectOption({ label: category });
  await page.getByLabel('Payee (optional)').fill(payee);
  await save(page);
  await expect(page.locator('.hero-amount')).toBeVisible();
}

test('search narrows the list; the total covers all matches, and a filtered account adds up to its lines', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addExpense(page, '45.60', 'Food › Groceries', 'Lidl');
  await addExpense(page, '10.00', 'Transport', 'Shell');

  await page.goto('/transactions');
  const total = page.getByTestId('search-total');
  // The opening balance is dated in January, so this month holds only the two expenses.
  await expect(page.getByText('2 transactions')).toBeVisible();
  await expect(total).toHaveText('−€55.60');
  await checkScreen(page, 'activity search');

  await page.getByLabel('From', { exact: true }).fill('2026-01-01');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.getByText('3 transactions')).toBeVisible();
  await expect(total).toHaveText('+€944.40');

  await page.getByLabel('Search').fill('lidl');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.getByText('1 transaction', { exact: true })).toBeVisible();
  await expect(total).toHaveText('−€45.60');
  await expect(page.getByRole('link', { name: /Lidl/ })).toBeVisible();

  // With one account chosen, each line shows its effect and the total is their sum.
  await page.getByLabel('Search').fill('');
  await page.getByText('More filters').click();
  await page.getByLabel('Account').selectOption({ label: 'Current' });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.getByText('3 transactions')).toBeVisible();
  await expect(total).toHaveText('+€944.40');
  await expect(page.getByRole('link', { name: /Opening balance/ })).toContainText('+€1,000.00');

  await page.getByLabel('From', { exact: true }).fill(today());
  await page.getByLabel('To', { exact: true }).fill('2020-01-01');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.locator('main [role=alert]')).toContainText('start date');
});

test('a known payee fills in its usual category; payees can be renamed and merged', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addExpense(page, '5.00', 'Household', 'Lidl');
  await addExpense(page, '6.00', 'Household', 'Lidl BG');

  await page.goto('/transactions/new');
  await expect(page.getByLabel('Amount')).toBeVisible();
  await page.getByLabel('Payee (optional)').fill('Lidl');
  await expect(page.getByLabel('Category').locator('option:checked')).toHaveText('Household');

  await page.goto('/settings/payees');
  await expect(page.getByLabel('Name').first()).toBeVisible();
  await checkScreen(page, 'payees');
  await page.getByRole('button', { name: 'Merge Lidl BG' }).click();
  await page.getByLabel('Merge into').selectOption({ label: 'Lidl' });
  await page.getByRole('button', { name: 'Merge', exact: true }).first().click();
  await expect(page.getByText('Payees merged.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge Lidl BG' })).toHaveCount(0);

  await page.goto('/transactions');
  await page.getByLabel('Search').fill('lidl');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.getByText('2 transactions')).toBeVisible();
  await expect(page.getByTestId('search-total')).toHaveText('−€11.00');
});
