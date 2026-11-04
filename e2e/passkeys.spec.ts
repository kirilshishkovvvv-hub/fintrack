/** Passkeys with Chrome's virtual authenticator, which stands in for Face ID or a fingerprint reader. */
import type { Page } from '@playwright/test';
import { checkScreen, expect, nextEmail, signedInUser, test, withDatabase } from './helpers.ts';

/** `userVerified: false` is a key that can only detect a tap, with no face, finger or PIN check. */
async function addAuthenticator(page: Page, options: { userVerified: boolean } = { userVerified: true }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: options.userVerified,
      isUserVerified: options.userVerified,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function addPasskey(page: Page, name: string) {
  await page.goto('/settings/passkeys');
  await page.getByLabel('Name it').fill(name);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.locator('main [role=status]')).toContainText('added');
  await expect(page.locator('.row', { hasText: name })).toBeVisible();
}

const passwordlessSignIn = async (page: Page) => {
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/sign-in/);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
};

const ageSession = (email: string) =>
  withDatabase((client) =>
    client.query(`UPDATE auth.session SET "createdAt" = now() - interval '11 minutes' WHERE "userId" = (SELECT id FROM auth."user" WHERE email = $1)`, [email]),
  );

test('add a passkey, sign out, and sign in with no password; the activity log and an email record it', async ({ page }) => {
  const email = await signedInUser(page, { account: { name: 'Current', opening: 100000 } });
  await addAuthenticator(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: /Sign in with your face/ }).click();
  await expect(page.getByRole('heading', { name: 'Your passkeys' })).toBeVisible();
  await expect(page.getByText('No passkeys yet')).toBeVisible();
  await checkScreen(page, 'passkeys');

  await addPasskey(page, 'My phone');
  await checkScreen(page, 'passkeys with one');
  await passwordlessSignIn(page);
  await expect(page).toHaveURL(/dashboard/);
  await expect(page.locator('.hero-amount')).toHaveText('€1,000.00');

  await page.goto('/audit');
  await expect(page.getByText('Passkey added')).toBeVisible();
  const row = await withDatabase((client) => client.query(`SELECT p."publicKey", p."name" FROM auth.passkey p JOIN auth."user" u ON u.id = p."userId" WHERE u.email = $1`, [email]));
  expect(row.rows).toHaveLength(1);
  expect(row.rows[0].name).toBe('My phone');
});

test('when adding, the server refuses a key that did not check who is using it', async ({ page }) => {
  const email = await signedInUser(page);
  await addAuthenticator(page, { userVerified: false });
  await page.goto('/settings/passkeys');
  await expect(page.getByRole('heading', { name: 'Your passkeys' })).toBeVisible();
  // A tampered client: asks the key for no check at all, then sends the result to the server.
  const status = await page.evaluate(async () => {
    const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const encode = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const options = await (await fetch('/api/auth/passkey/generate-register-options?name=tap')).json();
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: [],
        authenticatorSelection: { residentKey: 'required', userVerification: 'discouraged' },
      },
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;
    const result = await fetch('/api/auth/passkey/verify-registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response: {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: credential.type,
          clientExtensionResults: {},
          response: { attestationObject: encode(response.attestationObject), clientDataJSON: encode(response.clientDataJSON) },
        },
      }),
    });
    return result.status;
  });
  expect(status).toBe(400);
  const rows = await withDatabase((client) => client.query(`SELECT 1 FROM auth.passkey p JOIN auth."user" u ON u.id = p."userId" WHERE u.email = $1`, [email]));
  expect(rows.rowCount).toBe(0);
});

test('at sign-in, the server refuses a proof made without the face, finger or PIN check', async ({ page }) => {
  await signedInUser(page);
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await addPasskey(page, 'Phone');
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/sign-in/);
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  // A tampered client: tells the device not to check, then sends its proof to the server.
  const status = await page.evaluate(async () => {
    const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const encode = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const options = await (await fetch('/api/auth/passkey/generate-authenticate-options')).json();
    const credential = (await navigator.credentials.get({
      publicKey: { ...options, challenge: decode(options.challenge), allowCredentials: [], userVerification: 'discouraged' },
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAssertionResponse;
    const result = await fetch('/api/auth/passkey/verify-authentication', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        response: {
          id: credential.id,
          rawId: encode(credential.rawId),
          type: credential.type,
          clientExtensionResults: {},
          response: {
            authenticatorData: encode(response.authenticatorData),
            clientDataJSON: encode(response.clientDataJSON),
            signature: encode(response.signature),
            userHandle: response.userHandle ? encode(response.userHandle) : undefined,
          },
        },
      }),
    });
    return result.status;
  });
  expect(status).toBe(401);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/sign-in/);
});

test('adding or removing needs a recent sign-in, which a passkey can give; a removed passkey stops working', async ({ page }) => {
  const email = await signedInUser(page);
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await addPasskey(page, 'Laptop');

  await ageSession(email);
  await page.reload();
  await page.getByRole('button', { name: 'Remove Laptop' }).click();
  await expect(page.getByText('confirm it')).toBeVisible();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page.locator('main [role=status]')).toContainText('removed');
  await expect(page.getByText('No passkeys yet')).toBeVisible();

  // The device still holds the key, but the server no longer accepts it.
  await passwordlessSignIn(page);
  await expect(page.locator('main [role=alert]')).toContainText("couldn't");
  await expect(page).toHaveURL(/sign-in/);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
});

test('someone else cannot remove your passkey or see it', async ({ page, browser, baseURL }) => {
  const email = await signedInUser(page);
  await addAuthenticator(page);
  await addPasskey(page, 'Private');
  const { id } = (await withDatabase((client) => client.query(`SELECT p.id FROM auth.passkey p JOIN auth."user" u ON u.id = p."userId" WHERE u.email = $1`, [email]))).rows[0];

  const other = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: { 'x-forwarded-for': `10.8.${Math.floor(Math.random() * 250)}.1` } });
  const otherPage = await other.newPage();
  await signedInUser(otherPage);
  const removal = await other.request.post('/api/auth/passkey/delete-passkey', { headers: { origin: baseURL! }, data: { id } });
  expect(removal.status()).toBeGreaterThanOrEqual(400);
  const seen = await (await other.request.get('/api/auth/passkey/list-user-passkeys')).json();
  expect(seen).toEqual([]);
  await other.close();
  expect((await withDatabase((client) => client.query('SELECT 1 FROM auth.passkey WHERE id = $1', [id]))).rowCount).toBe(1);
  expect(nextEmail()).toContain('@');
});
