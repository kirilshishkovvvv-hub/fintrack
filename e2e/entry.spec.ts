/** Entering every kind of transaction on screen (FR-04, FR-06), with the remainder rule (BR-06.2). */
import type { Page } from '@playwright/test';
import { checkScreen, expect, signedInUser, test } from './helpers.ts';

async function withLoan(page: Page) {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  const created = await page.context().request.post('/api/v1/accounts', {
    headers: { origin: 'http://localhost:3100', 'idempotency-key': `e2e-${crypto.randomUUID()}` },
    data: { name: 'Loan', type: 'loan', openingDate: '2026-01-01', openingAmount_minor: 500000 },
  });
  expect(created.status()).toBe(201);
}
const hero = (page: Page) => page.locator('.hero-amount');
const openNew = async (page: Page) => {
  await page.goto('/transactions/new');
  await expect(page.getByLabel('Amount')).toBeVisible();
};

test('split: can\'t save with money unassigned; equal split of 100.00 gives 33.34, 33.33, 33.33 (AC-06.2); then edit it', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await openNew(page);
  await page.getByLabel('Amount').fill('100,00');
  await page.getByRole('button', { name: 'Split across categories' }).click();
  await page.getByLabel('Line 1: category').selectOption({ label: 'Food › Groceries' });
  await page.getByLabel('Line 2: category').selectOption({ label: 'Household' });
  await page.getByLabel('Line 1: amount').fill('60');
  await page.getByLabel('Line 2: amount').fill('30');
  await expect(page.getByText('Left to assign: €10.00')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('main [role=alert]')).toContainText('Left to assign');

  await page.getByRole('button', { name: 'Add a line' }).click();
  await page.getByLabel('Line 3: category').selectOption({ label: 'Transport' });
  await page.getByRole('button', { name: 'Split equally' }).click();
  await expect(page.getByLabel('Line 1: amount')).toHaveValue('33.34');
  await expect(page.getByLabel('Line 2: amount')).toHaveValue('33.33');
  await expect(page.getByLabel('Line 3: amount')).toHaveValue('33.33');
  await expect(page.getByText('Everything is assigned')).toBeVisible();
  await page.getByLabel('Line 1: note (optional)').fill('weekly shop');
  await checkScreen(page, 'split form');
  await page.getByLabel('Description (optional)').fill('Big shop');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€900.00');

  await page.getByRole('link', { name: /Big shop/ }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Line 1: amount')).toHaveValue('33.34');
  await expect(page.getByLabel('Line 1: note (optional)')).toHaveValue('weekly shop');
  await page.getByLabel('Total').fill('90');
  await page.getByRole('button', { name: 'Split by percent' }).click();
  await page.getByLabel('Line 1: percent').fill('50');
  await page.getByLabel('Line 2: percent').fill('25');
  await page.getByLabel('Line 3: percent').fill('25');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(hero(page)).toHaveText('−€90.00');
  await page.goto('/dashboard');
  await expect(hero(page)).toHaveText('€910.00');
});

test('refund from a purchase, larger only with confirmation; debt payment; a refund with no original', async ({ page }) => {
  await withLoan(page);
  await openNew(page);
  await page.getByLabel('Amount').fill('80');
  await page.getByLabel('Category').selectOption({ label: 'Shopping' });
  await page.getByLabel('Description (optional)').fill('Shoes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Spendable 1,000 − 80, with the loan not reserved.
  await expect(hero(page)).toHaveText('€920.00');

  await page.getByRole('link', { name: /Shoes/ }).click();
  await checkScreen(page, 'detail with actions');
  await page.getByRole('link', { name: 'Record a refund' }).click();
  await expect(page.getByText('Refund of Shoes')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Refund' })).toBeChecked();
  await page.getByLabel('Amount').fill('100');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('main [role=alert]')).toContainText('larger than the original');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByLabel('Amount').fill('30');
  await page.getByLabel('Yes, the refund really is larger').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€950.00');

  await page.getByRole('link', { name: /Shoes/ }).first().click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await page.goBack();

  await openNew(page);
  await page.locator('.segmented label', { hasText: 'Debt payment' }).click();
  await page.getByLabel('Amount off the debt').fill('200');
  await page.getByLabel('Debt or card').selectOption({ label: 'Loan' });
  await page.getByLabel('Interest (optional)').fill('15');
  await checkScreen(page, 'debt payment form');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€735.00');
  await expect(page.locator('.row', { hasText: 'Loan' }).first()).toContainText('−€4,800.00');

  await openNew(page);
  await page.locator('.segmented label', { hasText: 'Refund' }).click();
  await page.getByLabel('Amount').fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€740.00');
});

test('duplicate opens a copy dated today, with no links', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await openNew(page);
  await page.getByLabel('Amount').fill('12,50');
  await page.getByLabel('Description (optional)').fill('Lunch');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€987.50');
  await page.getByRole('link', { name: /Lunch/ }).click();
  await page.getByRole('link', { name: 'Duplicate' }).click();
  await expect(page.getByLabel('Amount')).toHaveValue('12.50');
  await expect(page.getByLabel('Description (optional)')).toHaveValue('Lunch');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(hero(page)).toHaveText('€975.00');
});
