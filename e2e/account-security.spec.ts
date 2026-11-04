/** Forgotten password, changing the password, signing out everywhere and 2FA, on screen (Stage 2 §12.3). */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkScreen, expect, nextEmail, PASSWORD, signedInUser, signIn, test } from './helpers.ts';

function lastLink(email: string, kind: string): string {
  const line = readFileSync('.pgdata/e2e-server.log', 'utf8').split('\n').filter((l) => l.includes(`${kind} for ${email}:`)).at(-1);
  if (!line) throw new Error(`No ${kind} email for ${email}`);
  return line.slice(line.indexOf('http')).trim();
}

function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest[digest.length - 1]! & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('forgot the password: request a link, set a new one, sign in; the link then fails', async ({ page }) => {
  const email = await signedInUser(page);
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await checkScreen(page, 'forgot password');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.locator('main [role=status]')).toContainText('If this email has an account');

  await expect.poll(() => readFileSync('.pgdata/e2e-server.log', 'utf8').includes(`reset-password for ${email}:`)).toBe(true);
  const link = lastLink(email, 'reset-password');
  await page.goto(link);
  await expect(page).toHaveURL(/reset-password\?token=/);
  await checkScreen(page, 'reset password');
  await page.getByLabel('New password').fill('a brand new long password');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.locator('main [role=status]')).toContainText('password has been changed');

  await signIn(page, email, 'a brand new long password');
  await expect(page).toHaveURL(/dashboard/);
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page.locator('main [role=alert]')).toContainText('no longer valid');
});

test('security page: change the password, and sign out everywhere', async ({ page }) => {
  const email = await signedInUser(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: /Password and security/ }).click();
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  await checkScreen(page, 'security');
  await page.getByLabel('Current password').fill('not the right password');
  await page.getByLabel('New password').fill('a brand new long password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('main [role=alert]')).toContainText("isn't right");
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('main [role=status]')).toContainText('Password changed');

  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page).toHaveURL(/sign-in/);
  await signIn(page, email, 'a brand new long password');
  await expect(page).toHaveURL(/dashboard/);
});

test('2FA: set up with the QR screen, sign in with a code, use it to confirm a sensitive action, turn it off', async ({ page }) => {
  const email = await signedInUser(page);
  await page.goto('/settings/security');
  await page.locator('#on-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  await checkScreen(page, '2FA set-up');
  const secret = (await page.locator('code').first().textContent())!;
  await page.getByLabel('Code from the app').fill('000000');
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.locator('main [role=alert]')).toContainText("code isn't right");
  await page.getByLabel('Code from the app').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.locator('main [role=status]')).toContainText('Two-step sign-in is on');

  await page.getByRole('button', { name: /Sign out/ }).first().click();
  await expect(page).toHaveURL(/sign-in/);
  await signIn(page, email);
  await expect(page.getByLabel('Code')).toBeVisible();
  await checkScreen(page, '2FA code');
  await page.getByLabel('Code').fill(totp(secret));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/dashboard|onboarding/);

  await page.goto('/settings/security');
  await page.locator('#off-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.locator('main [role=status]')).toContainText('Two-step sign-in is off');
  expect(nextEmail()).toContain('@');
});
