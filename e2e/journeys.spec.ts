/** The critical journeys of Stage 2 §12.3, on desktop and at 360 px, each with accessibility checks. */
import { readFileSync } from 'node:fs';
import { purgeDeletedWorkspaces } from '../packages/db/src/deletion-store.ts';
import pg from 'pg';
import { checkScreen, expect, nextEmail, PASSWORD, signedInUser, signIn, test, today, waitForVerificationLink, withDatabase } from './helpers.ts';

test('sign up → verify → create an account → expense → Safe to Spend matches; edit, undo, delete, restore', async ({ page }) => {
  const email = nextEmail();
  await page.goto('/sign-up');
  await checkScreen(page, 'sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('Accept the terms');
  await page.getByLabel('I accept the Terms of service').check();
  await page.getByLabel("I've read the Privacy notice").check();
  await page.getByLabel("I'm 18 or older").check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  await page.goto(await waitForVerificationLink(email));
  await expect(page.getByText('Your email is verified')).toBeVisible();
  await checkScreen(page, 'sign-in');
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Set up your money space' })).toBeVisible();
  await checkScreen(page, 'onboarding');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/dashboard/);
  await page.getByRole('link', { name: 'Add account' }).click();
  await checkScreen(page, 'new account');
  await page.getByLabel('Name').fill('Current');
  await page.getByLabel('Balance on that date').fill('1,000.00');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.locator('.hero-amount')).toHaveText('€1,000.00');
  await checkScreen(page, 'dashboard');

  await page.getByRole('link', { name: 'Add transaction' }).click();
  await expect(page.getByLabel('Amount')).toBeVisible();
  await checkScreen(page, 'new transaction');
  await page.getByLabel('Amount').fill('45,60');
  await page.getByLabel('Category').selectOption({ label: 'Food › Groceries' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.hero-amount')).toHaveText('€954.40');

  await page.getByRole('link', { name: /Groceries/ }).click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await checkScreen(page, 'transaction detail');
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Amount').fill('54,60');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.hero-amount')).toHaveText('−€54.60');
  await expect(page.getByText('−€45.60 → −€54.60')).toBeVisible();

  // Undo returns the previous version.
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(page.locator('.hero-amount')).toHaveText('−€45.60');

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  await checkScreen(page, 'activity');
  await page.getByRole('link', { name: 'Recently deleted' }).click();
  await expect(page.getByText('removed for good on')).toBeVisible();
  await checkScreen(page, 'trash');
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Nothing here.')).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.locator('.hero-amount')).toHaveText('€954.40');
});

test('import → review → confirm → undo, with a Windows-1251 file', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/import');
  await expect(page.getByLabel('CSV file')).toBeVisible();
  await checkScreen(page, 'import upload');

  const [year, month, day] = today().split('-');
  const date = `${day}.${month}.${year}`;
  const csv = `Извлечение\n\nДата;Основание;Сума\n${date};Кафе бар;-2,50\n${date};Кафе бар;-2,50\n${date};Наем;-600,00\nбъдеще;Лош ред;-1,00\nОбщо: 4\n`;
  const bytes = Buffer.from([...csv].map((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
  }));
  await page.getByLabel('CSV file').setInputFiles({ name: 'bank.csv', mimeType: 'text/csv', buffer: bytes });
  await expect(page.locator('main [role=status]')).toContainText('4 rows found, 1 unreadable');
  await expect(page.getByText('Наем')).toBeVisible();
  await checkScreen(page, 'import mapping');
  await page.getByRole('button', { name: 'Continue to review' }).click();

  await expect(page.getByRole('heading', { name: 'What we found' })).toBeVisible();
  await checkScreen(page, 'import review');
  const confirm = page.getByRole('button', { name: 'Confirm import' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('All amounts in this file are in EUR').check();
  await confirm.click();
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
  await checkScreen(page, 'import result');

  await page.goto('/dashboard');
  await expect(page.locator('.hero-amount')).toHaveText('€395.00');

  await page.goBack();
  await page.getByRole('button', { name: 'Undo this import' }).click();
  await expect(page.getByText('Undone').first()).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.locator('.hero-amount')).toHaveText('€1,000.00');
});

test('reconcile with an adjustment; the transactions lock; an unlock marks it as needing redoing', async ({ page }) => {
  await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/accounts');
  await checkScreen(page, 'accounts');
  await page.getByRole('link', { name: /Current/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Update the balance' })).toBeVisible();
  await checkScreen(page, 'account');
  await page.getByRole('link', { name: 'Reconcile with a statement' }).click();

  await page.getByLabel('Statement balance').fill('992,00');
  await page.getByRole('button', { name: 'Show transactions' }).click();
  await expect(page.getByText('Close the difference with an adjustment of −€8.00')).toBeVisible();
  await checkScreen(page, 'reconcile');
  await page.getByRole('button', { name: 'Record the adjustment and lock' }).click();

  await expect(page.getByText('Locked')).toBeVisible();
  await expect(page.locator('.hero-amount')).toHaveText('€992.00');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('needing to be redone');
  await checkScreen(page, 'unlock warning');
  await page.getByRole('button', { name: 'Yes, unlock' }).click();
  await expect(page.getByText('Needs redoing')).toBeVisible();
});

test('categories can be merged and the activity log shows it', async ({ page }) => {
  await signedInUser(page);
  await page.goto('/categories');
  await expect(page.getByRole('heading', { name: 'Spending' })).toBeVisible();
  await checkScreen(page, 'categories');
  await page.locator('.row', { hasText: 'Gifts' }).getByRole('button', { name: 'Merge' }).click();
  await page.getByLabel('Merge into').selectOption({ label: 'Travel' });
  await page.locator('form').getByRole('button', { name: 'Merge' }).click();
  await expect(page.locator('main [role=status]')).toContainText('Gifts was merged into Travel');
  await page.goto('/settings');
  await checkScreen(page, 'settings');
  await page.getByRole('link', { name: /Activity log/ }).click();
  await expect(page.getByText('Categories merged')).toBeVisible();
  await checkScreen(page, 'activity log');
});

test('encrypted export → deletion request → sign in again → cancel; then a second request is purged', async ({ page }) => {
  const email = await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await page.goto('/export');
  await expect(page.getByLabel('File password')).toBeVisible();
  await checkScreen(page, 'export');
  await page.getByLabel('File password').fill('a long file password');
  await page.getByLabel('Repeat the password').fill('not the same password');
  await page.getByRole('button', { name: 'Download encrypted file' }).click();
  await expect(page.locator('main [role=alert]')).toContainText("don't match");
  await page.getByLabel('File password').fill('a long file password');
  await page.getByLabel('Repeat the password').fill('a long file password');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download encrypted file' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^fintrack-export-.*\.zip$/);
  const contents = readFileSync(await file.path());
  expect(contents.subarray(0, 2).toString()).toBe('PK');
  expect(contents.includes('Current,current')).toBe(false);

  const requestDeletion = async () => {
    await page.goto('/delete-account');
    const remove = page.getByRole('button', { name: 'Delete my account' });
    await expect(remove).toBeDisabled();
    await page.getByLabel('I understand my data will be erased').check();
    await remove.click();
    await expect(page.getByRole('heading', { name: 'Your account is scheduled for deletion' })).toBeVisible();
  };
  await requestDeletion();
  await checkScreen(page, 'deletion requested');

  await signIn(page, email);
  await expect(page).toHaveURL(/delete-account/);
  await checkScreen(page, 'deletion pending');
  await page.getByRole('button', { name: 'Keep my account' }).click();
  await expect(page.getByText('Your account is safe')).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.locator('.hero-amount')).toHaveText('€1,000.00');

  await requestDeletion();
  await withDatabase(async (client) => {
    await client.query(
      `UPDATE fin.workspaces SET deletion_requested_at = now() - interval '8 days'
        WHERE id = (SELECT m.workspace_id FROM fin.memberships m JOIN auth."user" u ON u.id = m.user_id WHERE u.email = $1)`,
      [email],
    );
  });
  const { url } = JSON.parse(readFileSync('.pgdata/e2e-db.json', 'utf8')) as { url: string };
  const pool = new pg.Pool({ connectionString: url });
  await purgeDeletedWorkspaces(pool).finally(() => pool.end());

  await signIn(page, email);
  await expect(page.locator('main [role=alert]')).toContainText("don't match");
});

test('keyboard only: sign in and reach the dashboard, with the skip link first', async ({ page }) => {
  const email = await signedInUser(page);
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/dashboard/);
});
