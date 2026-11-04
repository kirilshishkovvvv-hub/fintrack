/** Editing an account and its opening balance, categories, general settings, profile and the legal pages, on screen. */
import { checkScreen, expect, signedInUser, test } from './helpers.ts';

test('edit an account and its opening balance; Safe to Spend follows', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/accounts');
  await page.getByRole('link', { name: /Current/ }).first().click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name')).toHaveValue('Current');
  await checkScreen(page, 'edit account');

  await page.getByLabel('Name').fill('Main account');
  await page.getByLabel('Bank or provider (optional)').fill('DSK');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('main [role=status]')).toHaveText('Saved.');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Main account');

  await page.getByLabel('Balance on the opening date').fill('1200');
  await page.getByRole('button', { name: 'Change opening balance' }).click();
  await expect(page.locator('main [role=status]')).toHaveText('Opening balance changed.');

  await page.getByLabel('Opening date', { exact: true }).fill('2030-01-01');
  await page.getByRole('button', { name: 'Change opening balance' }).click();
  await expect(page.locator('main [role=alert]')).not.toHaveCount(0);

  await page.goto('/dashboard');
  await expect(page.locator('.hero-amount')).toHaveText('€1,200.00');
});

test('add, rename, move and reorder categories', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/categories');
  await expect(page.getByRole('button', { name: 'Edit Household' })).toBeVisible();
  await checkScreen(page, 'categories');

  await page.getByLabel('Name').fill('Pets');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('main [role=status]')).toHaveText('Pets added.');

  await page.getByRole('button', { name: 'Edit Pets' }).click();
  await page.locator('#edit-name').fill('Animals');
  await page.locator('#edit-parent').selectOption({ label: 'Household' });
  await expect(page.getByText('Moving a subcategory also moves')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('main [role=status]')).toHaveText('Animals saved.');
  await expect(page.getByText('Household › Animals')).toBeVisible();

  const expense = page.getByRole('region', { name: 'Spending' }).or(page.locator('section[aria-labelledby=expense-title]'));
  const position = async (name: RegExp) => (await expense.locator('.row-title').allTextContents()).findIndex((text) => name.test(text));
  const before = await position(/^Transport/);
  await page.getByRole('button', { name: 'Move Transport down' }).click();
  await expect(page.locator('main [role=status]')).toHaveText('Transport moved.');
  await expect.poll(() => position(/^Transport/)).toBeGreaterThan(before);
});

test('the protected reserve lowers Safe to Spend; the currency is locked; the marketing choice sticks', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/settings/general');
  await expect(page.getByLabel('Protected reserve')).toHaveValue('0.00');
  await expect(page.getByLabel('Currency')).toBeDisabled();
  await checkScreen(page, 'general settings');
  await page.getByLabel('Protected reserve').fill('250');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('main [role=status]')).toHaveText('Saved.');
  await page.goto('/dashboard');
  await expect(page.locator('.hero-amount')).toHaveText('€750.00');

  await page.goto('/settings/profile');
  const marketing = page.getByLabel('Send me occasional product news');
  await expect(marketing).not.toBeChecked();
  await checkScreen(page, 'profile');
  await marketing.click();
  await expect(page.locator('main [role=status]')).toHaveText('Saved.');
  await page.reload();
  await expect(page.getByLabel('Send me occasional product news')).toBeChecked();
});

test('legal pages are public, say they are drafts, and open from sign-up', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('link', { name: 'Terms of service' })).toHaveAttribute('href', '/legal/terms');
  await expect(page.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', '/legal/privacy');
  for (const [path, heading] of [
    ['/legal/terms', 'Terms of service'],
    ['/legal/privacy', 'Privacy notice'],
    ['/legal/cookies', 'Cookies'],
    ['/legal/imprint', 'Who runs this service'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expect(page.getByText("hasn't been reviewed by a lawyer")).toBeVisible();
    await checkScreen(page, heading);
  }
  await page.goto('/legal/cookies');
  await expect(page.getByText('fintrack.known_device')).toBeVisible();
  const missing = await page.goto('/legal/nonsense');
  expect(missing?.status()).toBe(404);
});
