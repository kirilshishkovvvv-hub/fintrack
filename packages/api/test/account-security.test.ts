/**
 * Password reset and change, email change, signing out everywhere, 2FA and the new-device notice
 * (FR-01, BR-01.4 to BR-01.6, AC-01.2 to AC-01.4, AD-15).
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client, PASSWORD, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;
const nextEmail = () => `account-${++counter}@example.com`;
const NEW_PASSWORD = 'another long password here';
const sql = (text: string, values: unknown[] = []) => harness.database.pool.query(text, values);
const signIn = (client: Client, email: string, password = PASSWORD, extra: object = {}) => client.call('POST', '/api/auth/sign-in/email', { body: { email, password, ...extra } });
const lastEmail = (to: string, kind: string) => [...harness.emails].reverse().find((sent) => sent.to === to && sent.kind === kind);
const countEmails = (to: string, kind: string) => harness.emails.filter((sent) => sent.to === to && sent.kind === kind).length;
const stale = (email: string) => sql(`UPDATE auth.session SET "createdAt" = now() - interval '11 minutes' WHERE "userId" = (SELECT id FROM auth."user" WHERE email = $1)`, [email]);
const events = async (email: string) =>
  (await sql(`SELECT event_type FROM fin.audit_events WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1) ORDER BY id`, [email])).rows.map((row) => row.event_type);

describe('password reset (BR-01.4)', () => {
  const requestReset = (client: Client, email: string) => client.call('POST', '/api/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } });
  async function linkFor(email: string) {
    await requestReset(new Client(harness), email);
    const url = new URL(lastEmail(email, 'reset-password')!.url);
    const token = url.pathname.split('/').pop()!;
    return { url, token };
  }
  const reset = (token: string, newPassword = NEW_PASSWORD) => new Client(harness).call('POST', '/api/auth/reset-password', { body: { token, newPassword } });

  test('AC-01.2: an existing and an unknown address get the same answer, and only the real one gets an email', async () => {
    const email = nextEmail();
    await verifiedUser(harness, email);
    const known = await requestReset(new Client(harness), email);
    const unknown = await requestReset(new Client(harness), `nobody-${counter}@example.com`);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(lastEmail(`nobody-${counter}@example.com`, 'reset-password')).toBeUndefined();
    expect(lastEmail(email, 'reset-password')).toBeDefined();
  });

  test('AC-01.3: the link works once; afterwards the new password works, the old one does not, and every session has ended', async () => {
    const email = nextEmail();
    const session = await verifiedUser(harness, email);
    const { url, token } = await linkFor(email);
    const opened = await harness.handle(new Request(`${url.origin}${url.pathname}${url.search}`, { redirect: 'manual' }));
    expect(opened.status).toBe(302);
    expect(opened.headers.get('location')).toContain(`/reset-password?token=${token}`);

    expect((await reset(token)).status).toBe(200);
    expect((await session.call('GET', '/api/v1/accounts')).status).toBe(401);
    expect((await signIn(new Client(harness), email)).status).toBe(401);
    expect((await signIn(new Client(harness), email, NEW_PASSWORD)).status).toBe(200);
    expect((await reset(token, 'yet another long password')).status).toBe(400);
    expect(countEmails(email, 'password-changed')).toBe(1);
    expect(await events(email)).toContain('auth.password_changed');
  });

  test('AC-01.3: the link fails after 60 minutes, and it expires at 60 minutes', async () => {
    const email = nextEmail();
    await verifiedUser(harness, email);
    const { token } = await linkFor(email);
    const row = await sql(`SELECT extract(epoch FROM "expiresAt" - now())::int AS seconds FROM auth.verification WHERE identifier = $1`, [`reset-password:${token}`]);
    expect(row.rows[0].seconds).toBeGreaterThan(59 * 60);
    expect(row.rows[0].seconds).toBeLessThanOrEqual(60 * 60);
    await sql(`UPDATE auth.verification SET "expiresAt" = now() - interval '1 minute' WHERE identifier = $1`, [`reset-password:${token}`]);
    expect((await reset(token)).status).toBe(400);
    expect((await signIn(new Client(harness), email)).status).toBe(200);
  });

  test('a short new password is refused', async () => {
    const email = nextEmail();
    await verifiedUser(harness, email);
    const { token } = await linkFor(email);
    expect((await reset(token, 'too short')).status).toBe(400);
  });
});

describe('changing the password (BR-01.5, AC-01.4)', () => {
  const change = (client: Client, currentPassword: string, extra: object = {}) =>
    client.call('POST', '/api/auth/change-password', { body: { currentPassword, newPassword: NEW_PASSWORD, ...extra } });

  test('AC-01.4: every other session stops at once, even if the request asks otherwise; this one continues', async () => {
    const email = nextEmail();
    const here = await verifiedUser(harness, email);
    const elsewhere = new Client(harness);
    await signIn(elsewhere, email);
    await here.call('POST', '/api/v1/workspaces', { body: { name: 'P', currency: 'EUR', timezone: 'Europe/Sofia' } });
    const result = await change(here, PASSWORD, { revokeOtherSessions: false });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await elsewhere.call('GET', '/api/v1/workspace')).status).toBe(401);
    expect((await here.call('GET', '/api/v1/workspace')).status).toBe(200);
    expect(countEmails(email, 'password-changed')).toBe(1);
    expect(await events(email)).toContain('auth.password_changed');
  });

  test('it needs the current password and a recent sign-in', async () => {
    const email = nextEmail();
    const client = await verifiedUser(harness, email);
    expect((await change(client, 'not the current password')).status).toBe(400);
    await stale(email);
    const refused = await change(client, PASSWORD);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('REAUTH_REQUIRED');
    expect((await signIn(new Client(harness), email)).status).toBe(200);
  });
});

describe('changing the email (FR-01)', () => {
  test('the new address confirms, the old one is told, and nothing changes until then', async () => {
    const email = nextEmail();
    const newEmail = `moved-${counter}@example.com`;
    const client = await verifiedUser(harness, email);
    const result = await client.call('POST', '/api/auth/change-email', { body: { newEmail, callbackURL: '/settings/security' } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(lastEmail(email, 'email-change-requested')).toBeDefined();
    expect((await signIn(new Client(harness), email)).status).toBe(200);

    const link = new URL(lastEmail(newEmail, 'verify-email')!.url);
    await client.call('GET', `${link.pathname}${link.search}`);
    expect((await signIn(new Client(harness), newEmail)).status).toBe(200);
    expect((await signIn(new Client(harness), email)).status).toBe(401);
  });

  test('it needs a recent sign-in', async () => {
    const email = nextEmail();
    const client = await verifiedUser(harness, email);
    await stale(email);
    expect((await client.call('POST', '/api/auth/change-email', { body: { newEmail: `x-${counter}@example.com` } })).body.code).toBe('REAUTH_REQUIRED');
  });
});

describe('signing out everywhere', () => {
  test('ends every session, and the audit log records it', async () => {
    const email = nextEmail();
    const here = await verifiedUser(harness, email);
    const elsewhere = new Client(harness);
    await signIn(elsewhere, email);
    expect((await here.call('POST', '/api/auth/revoke-sessions', { body: {} })).status).toBe(200);
    expect((await here.call('GET', '/api/v1/accounts')).status).toBe(401);
    expect((await elsewhere.call('GET', '/api/v1/accounts')).status).toBe(401);
    expect(await events(email)).toContain('auth.sessions_revoked');
  });
});

/** RFC 6238, written out here so the test doesn't share code with what it checks. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', key).update(counterBytes).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

describe('2FA, optional, at launch (AD-15)', () => {
  async function enrolled() {
    const email = nextEmail();
    const client = await verifiedUser(harness, email);
    const started = await client.call('POST', '/api/auth/two-factor/enable', { body: { password: PASSWORD } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const secret = new URL(started.body.totpURI).searchParams.get('secret')!;
    return { email, client, secret, backupCodes: started.body.backupCodes as string[] };
  }
  const verified = async (client: Client, secret: string) => {
    const result = await client.call('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  };

  test('it stays off until a code proves the app is set up; then a password alone no longer signs in', async () => {
    const { email, client, secret } = await enrolled();
    expect((await signIn(new Client(harness), email)).body.twoFactorRedirect).toBeUndefined();
    await verified(client, secret);
    expect(lastEmail(email, 'two-factor-enabled')).toBeDefined();
    expect(await events(email)).toContain('auth.2fa_enabled');

    const next = new Client(harness);
    const first = await signIn(next, email);
    expect(first.status).toBe(200);
    expect(first.body.twoFactorRedirect).toBe(true);
    expect((await next.call('GET', '/api/v1/accounts')).status).toBe(401);

    expect((await next.call('POST', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } })).status).toBeGreaterThanOrEqual(400);
    await verified(next, secret);
    expect((await next.call('GET', '/api/v1/workspace')).body.code).toBe('NO_WORKSPACE');
  });

  test('the audit log says signed in only after the code', async () => {
    const { email, client, secret } = await enrolled();
    await verified(client, secret);
    const count = async () => (await events(email)).filter((type) => type === 'auth.login').length;
    const before = await count();
    const next = new Client(harness);
    await signIn(next, email);
    expect(await count()).toBe(before);
    await verified(next, secret);
    expect(await count()).toBe(before + 1);
  });

  test('a backup code works once', async () => {
    const { email, client, secret, backupCodes } = await enrolled();
    await verified(client, secret);
    expect(backupCodes.length).toBeGreaterThan(0);
    const first = new Client(harness);
    await signIn(first, email);
    expect((await first.call('POST', '/api/auth/two-factor/verify-backup-code', { body: { code: backupCodes[0] } })).status).toBe(200);
    const second = new Client(harness);
    await signIn(second, email);
    expect((await second.call('POST', '/api/auth/two-factor/verify-backup-code', { body: { code: backupCodes[0] } })).status).toBeGreaterThanOrEqual(400);
  });

  test('repeated wrong codes are stopped, and a device can never be trusted', async () => {
    const { email, client, secret } = await enrolled();
    await verified(client, secret);
    const attacker = new Client(harness);
    await signIn(attacker, email);
    let stopped = false;
    for (let i = 0; i < 12 && !stopped; i += 1) {
      const result = await attacker.call('POST', '/api/auth/two-factor/verify-totp', { body: { code: '000000' } });
      stopped = result.status === 429 || /too many|locked/i.test(JSON.stringify(result.body));
    }
    expect(stopped).toBe(true);
    const trusted = new Client(harness);
    await signIn(trusted, email);
    await trusted.call('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret), trustDevice: true } });
    expect(trusted.cookie).not.toContain('trust_device');
  });

  test('"keep me signed in" survives the code step, and stays off when not chosen', async () => {
    const { email, client, secret } = await enrolled();
    await verified(client, secret);
    const keepOf = async (c: Client) => (await sql(`SELECT "keepSignedIn" FROM auth.session WHERE token = $1`, [decodeURIComponent(c.cookie.match(/session_token=([^;.]+)/)![1]!)])).rows[0].keepSignedIn;
    const kept = new Client(harness);
    await signIn(kept, email, PASSWORD, { rememberMe: true });
    await verified(kept, secret);
    expect(await keepOf(kept)).toBe(true);
    const plain = new Client(harness);
    await signIn(plain, email);
    await verified(plain, secret);
    expect(await keepOf(plain)).toBe(false);
  });

  test('turning it on or off needs a recent sign-in; off needs the password, and sends a notice', async () => {
    const { email, client, secret } = await enrolled();
    await verified(client, secret);
    expect((await client.call('POST', '/api/auth/two-factor/disable', { body: { password: 'not the password here' } })).status).toBeGreaterThanOrEqual(400);
    await stale(email);
    expect((await client.call('POST', '/api/auth/two-factor/disable', { body: { password: PASSWORD } })).body.code).toBe('REAUTH_REQUIRED');
    await sql(`UPDATE auth.session SET "createdAt" = now() WHERE "userId" = (SELECT id FROM auth."user" WHERE email = $1)`, [email]);
    const off = await client.call('POST', '/api/auth/two-factor/disable', { body: { password: PASSWORD } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(lastEmail(email, 'two-factor-disabled')).toBeDefined();
    expect((await signIn(new Client(harness), email)).body.twoFactorRedirect).toBeUndefined();
  });
});

describe('new-device notice (BR-01.6)', () => {
  test('an email goes out for a browser not seen before, not for a brand-new account or a known browser', async () => {
    const email = nextEmail();
    const first = await verifiedUser(harness, email);
    expect(countEmails(email, 'new-device-sign-in')).toBe(0);
    await sql(`UPDATE auth."user" SET "createdAt" = now() - interval '2 days' WHERE email = $1`, [email]);

    await signIn(first, email);
    expect(countEmails(email, 'new-device-sign-in')).toBe(0);
    const other = new Client(harness);
    await signIn(other, email);
    expect(countEmails(email, 'new-device-sign-in')).toBe(1);
    await signIn(other, email);
    expect(countEmails(email, 'new-device-sign-in')).toBe(1);
  });
});
