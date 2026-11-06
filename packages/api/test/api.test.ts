/**
 * API tests (Stage 2 §12.1): login rules (FR-01), the ledger through the API, idempotency,
 * CSRF protection, isolation between users (GT-59, ISO-1 to ISO-5) and a USD workspace (GT-70).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client, CONSENTS, key, PASSWORD, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

async function setUpGt03(client: Client, currency: 'EUR' | 'USD') {
  const workspace = await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency, timezone: 'Europe/Sofia' } });
  expect(workspace.status).toBe(201);
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((item) => item.name === name)!.id;
  const account = async (name: string, type: string, opening: number) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: '2026-03-01', openingAmount_minor: opening } })).body.id as string;
  const current = await account('Current', 'current', 100000);
  const cash = await account('Cash wallet', 'cash', 10000);
  await account('Savings', 'savings', 200000);
  const post = (body: unknown) => client.call('POST', '/api/v1/transactions', { key: key(), body });
  expect((await post({ kind: 'income', date: '2026-03-10', accountId: current, lines: [{ categoryId: category('Salary'), amount_minor: 200000 }] })).status).toBe(201);
  expect((await post({ kind: 'expense', date: '2026-03-12', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 4560 }] })).status).toBe(201);
  expect((await post({ kind: 'expense', date: '2026-03-14', accountId: cash, lines: [{ categoryId: category('Food'), amount_minor: 1200 }] })).status).toBe(201);
  return { current, cash, category };
}

describe('login (FR-01)', () => {
  test('passwords under 12 characters are rejected (BR-01.2)', async () => {
    const client = new Client(harness);
    const result = await client.call('POST', '/api/auth/sign-up/email', { body: { email: 'short@example.com', password: 'short-pass', name: 'Short', consents: CONSENTS } });
    expect(result.status).toBe(400);
  });

  test('an unverified account cannot sign in or reach financial data (AC-01.1)', async () => {
    const client = new Client(harness);
    await client.call('POST', '/api/auth/sign-up/email', { body: { email: 'unverified@example.com', password: PASSWORD, name: 'Unverified', consents: CONSENTS } });
    const signIn = await client.call('POST', '/api/auth/sign-in/email', { body: { email: 'unverified@example.com', password: PASSWORD } });
    expect(signIn.status).toBe(403);
    expect((await client.call('GET', '/api/v1/workspace')).status).toBe(401);
  });

  test('a lost link: signing in with the right password sends a new one, and the wrong password sends nothing', async () => {
    const client = new Client(harness);
    const email = 'lost-link@example.com';
    const links = () => harness.emails.filter((sent) => sent.to === email && sent.kind === 'verify-email').length;
    await client.call('POST', '/api/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'Lost', consents: CONSENTS } });
    expect(links()).toBe(1);
    await client.call('POST', '/api/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'Lost', consents: CONSENTS } });
    expect(links()).toBe(1);
    expect((await client.call('POST', '/api/auth/sign-in/email', { body: { email, password: 'not the right password' } })).status).toBe(401);
    expect(links()).toBe(1);
    expect((await client.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(403);
    expect(links()).toBe(2);
  });

  test('signing up again with an existing email looks the same as a new sign-up (AC-01.2)', async () => {
    await verifiedUser(harness, 'existing@example.com');
    const fresh = await new Client(harness).call('POST', '/api/auth/sign-up/email', { body: { email: 'brand-new@example.com', password: PASSWORD, name: 'x', consents: CONSENTS } });
    const again = await new Client(harness).call('POST', '/api/auth/sign-up/email', { body: { email: 'existing@example.com', password: PASSWORD, name: 'x', consents: CONSENTS } });
    expect(again.status).toBe(fresh.status);
    expect(Object.keys(again.body ?? {}).sort()).toEqual(Object.keys(fresh.body ?? {}).sort());
  });

  test('sign-up needs the terms, the privacy notice and the 18+ confirmation (Annex L items 6, 17)', async () => {
    const missing = [{}, { terms: true, privacy: true }, { terms: true, privacy: true, age18: false }, { terms: 'yes', privacy: true, age18: true }];
    for (const consents of missing) {
      const result = await new Client(harness).call('POST', '/api/auth/sign-up/email', {
        body: { email: 'no-consent@example.com', password: PASSWORD, name: 'x', consents },
      });
      expect(result.status, JSON.stringify(consents)).toBe(400);
    }
    const users = await harness.database.pool.query(`SELECT 1 FROM auth."user" WHERE email = 'no-consent@example.com'`);
    expect(users.rowCount).toBe(0);
  });

  test('accepted consents are stored with their document versions, marketing off by default', async () => {
    await verifiedUser(harness, 'consent@example.com');
    const result = await harness.database.pool.query(
      `SELECT c.document, c.version, c.accepted FROM fin.consent_records c
         JOIN auth."user" u ON u.id = c.user_id WHERE u.email = 'consent@example.com' ORDER BY c.document`,
    );
    expect(result.rows).toEqual([
      { document: 'age_18', version: '1', accepted: true },
      { document: 'marketing', version: '1', accepted: false },
      { document: 'privacy', version: 'draft-2026-11', accepted: true },
      { document: 'terms', version: 'draft-2026-11', accepted: true },
    ]);
  });

  test('passwords are stored as Argon2id hashes', async () => {
    await verifiedUser(harness, 'hash-check@example.com');
    const result = await harness.database.pool.query(
      `SELECT a.password FROM auth.account a JOIN auth."user" u ON u.id = a."userId" WHERE u.email = 'hash-check@example.com'`,
    );
    expect(result.rows[0].password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  test('without a session every financial endpoint answers 401', async () => {
    const anonymous = new Client(harness);
    for (const path of ['/api/v1/workspace', '/api/v1/accounts', '/api/v1/categories', '/api/v1/summary']) {
      expect((await anonymous.call('GET', path)).status, path).toBe(401);
    }
  });

  test('activity slides the session expiry forward, and the refreshed cookie reaches the browser (AD-14)', async () => {
    await verifiedUser(harness, 'sliding@example.com');
    const client = new Client(harness);
    await client.call('POST', '/api/auth/sign-in/email', { body: { email: 'sliding@example.com', password: PASSWORD, rememberMe: true } });
    await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
    // A day since the last refresh: past the 5-minute update age, so the next request slides it.
    await harness.database.pool.query(
      `UPDATE auth.session SET "expiresAt" = now() + interval '13 days'
        WHERE "userId" = (SELECT id FROM auth."user" WHERE email = 'sliding@example.com')`,
    );
    const result = await client.call('GET', '/api/v1/workspace');
    expect(result.status).toBe(200);
    const cookie = result.headers.getSetCookie().find((header) => header.includes('session_token='));
    expect(cookie).toMatch(/Max-Age=1209600/i);
    const expiry = await harness.database.pool.query(
      `SELECT extract(epoch FROM "expiresAt" - now())::int AS seconds FROM auth.session
        WHERE "keepSignedIn" AND "userId" = (SELECT id FROM auth."user" WHERE email = 'sliding@example.com')`,
    );
    expect(expiry.rows[0].seconds).toBeGreaterThan(13.5 * 24 * 60 * 60);
  });

  test('after signing out, the old session stops working at once (AC-01.4)', async () => {
    const client = await verifiedUser(harness, 'signout@example.com');
    await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
    const oldCookie = client.cookie;
    expect((await client.call('GET', '/api/v1/workspace')).status).toBe(200);
    await client.call('POST', '/api/auth/sign-out', { body: {} });
    const replay = new Client(harness);
    replay.cookie = oldCookie;
    expect((await replay.call('GET', '/api/v1/workspace')).status).toBe(401);
  });
});

describe('the ledger through the API', () => {
  test('GT-03 gives the Stage 1 numbers, with a workspace created once (A-5)', async () => {
    const client = await verifiedUser(harness, 'gt03@example.com');
    await setUpGt03(client, 'EUR');
    const again = await client.call('POST', '/api/v1/workspaces', { body: { name: 'Second', currency: 'USD', timezone: 'Europe/Sofia' } });
    expect(again.status).toBe(200);
    expect(again.body.currency).toBe('EUR');

    const summary = (await client.call('GET', '/api/v1/summary?at=2026-03-31')).body;
    expect(summary.assets_minor).toBe(504240);
    expect(summary.netWorth_minor).toBe(504240);
    expect(summary.safeToSpend.value_minor).toBe(304240);
    const balances = Object.fromEntries(((await client.call('GET', '/api/v1/accounts')).body.items as any[]).map((a) => [a.name, a.balance_minor]));
    expect(balances).toEqual({ Current: 295440, 'Cash wallet': 8800, Savings: 200000 });
    const march = (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-31')).body.items;
    expect(march).toHaveLength(6);
  });

  test('the API rejects future dates, unknown references and fields it does not accept', async () => {
    const client = await verifiedUser(harness, 'rules@example.com');
    const { current, category } = await setUpGt03(client, 'EUR');
    const future = await client.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'expense', date: '2099-01-01', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 100 }] },
    });
    expect(future.status).toBe(422);
    expect(future.body.code).toBe('LEDGER_RULE');
    const unknown = await client.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'expense', date: '2026-03-15', accountId: current, lines: [{ categoryId: '00000000-0000-7000-8000-000000000000', amount_minor: 100 }] },
    });
    expect(unknown.status).toBe(422);
    const fabricated = await client.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'expense', date: '2026-03-15', accountId: current, balance_minor: 999999, lines: [{ categoryId: category('Food'), amount_minor: 100 }] },
    });
    expect(fabricated.status).toBe(422);
    expect(fabricated.body.code).toBe('VALIDATION_FAILED');
  });

  test('state-changing requests from another origin are refused', async () => {
    const client = await verifiedUser(harness, 'csrf@example.com');
    const result = await client.call('POST', '/api/v1/workspaces', {
      origin: 'https://evil.example',
      body: { name: 'x', currency: 'EUR', timezone: 'Europe/Sofia' },
    });
    expect(result.status).toBe(403);
    expect((await client.call('POST', '/api/v1/workspaces', { origin: null, body: { name: 'x', currency: 'EUR', timezone: 'Europe/Sofia' } })).status).toBe(403);
  });
});

describe('idempotency (Stage 2 §7.5)', () => {
  test('a retried request returns the stored result and creates nothing twice', async () => {
    const client = await verifiedUser(harness, 'idem@example.com');
    const { current, category } = await setUpGt03(client, 'EUR');
    const body = { kind: 'expense', date: '2026-03-20', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 999 }] };
    const idemKey = key();
    const first = await client.call('POST', '/api/v1/transactions', { key: idemKey, body });
    const second = await client.call('POST', '/api/v1/transactions', { key: idemKey, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    const changed = await client.call('POST', '/api/v1/transactions', { key: idemKey, body: { ...body, date: '2026-03-21' } });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const items = (await client.call('GET', '/api/v1/transactions?from=2026-03-20&to=2026-03-21')).body.items;
    expect(items).toHaveLength(1);
  });

  test('simultaneous duplicates still create exactly one transaction', async () => {
    const client = await verifiedUser(harness, 'idem-parallel@example.com');
    const { current, category } = await setUpGt03(client, 'EUR');
    const body = { kind: 'expense', date: '2026-03-22', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 500 }] };
    const idemKey = key();
    const results = await Promise.all(Array.from({ length: 5 }, () => client.call('POST', '/api/v1/transactions', { key: idemKey, body })));
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    expect((await client.call('GET', '/api/v1/transactions?from=2026-03-22&to=2026-03-22')).body.items).toHaveLength(1);
  });

  test('a write without an Idempotency-Key is refused', async () => {
    const client = await verifiedUser(harness, 'idem-missing@example.com');
    const { current, category } = await setUpGt03(client, 'EUR');
    const result = await client.call('POST', '/api/v1/transactions', {
      body: { kind: 'expense', date: '2026-03-23', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 100 }] },
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('GT-59 · isolation between two users through the API', () => {
  test("user B can't see, use or change anything of user A's", async () => {
    const userA = await verifiedUser(harness, 'gt59-a@example.com');
    const a = await setUpGt03(userA, 'EUR');
    const aTransaction = (await userA.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-31')).body.items[0].id as string;
    const aSummaryBefore = (await userA.call('GET', '/api/v1/summary?at=2026-03-31')).body;

    const userB = await verifiedUser(harness, 'gt59-b@example.com');
    await userB.call('POST', '/api/v1/workspaces', { body: { name: 'B', currency: 'EUR', timezone: 'Europe/Sofia' } });
    const bAccount = (await userB.call('POST', '/api/v1/accounts', { key: key(), body: { name: 'B current', type: 'current', openingDate: '2026-03-01', openingAmount_minor: 5000 } })).body.id;

    expect((await userB.call('GET', `/api/v1/transactions/${aTransaction}`)).status).toBe(404); // ISO-1
    const usingA = await userB.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'expense', date: '2026-03-15', accountId: bAccount, lines: [{ categoryId: a.category('Food'), amount_minor: 100 }] },
    });
    expect(usingA.status).toBe(422); // ISO-3
    const fromA = await userB.call('POST', '/api/v1/transfers', {
      key: key(),
      body: { date: '2026-03-15', fromAccountId: a.current, toAccountId: bAccount, amount_minor: 100 },
    });
    expect(fromA.status).toBe(422);

    const bAccounts = (await userB.call('GET', '/api/v1/accounts')).body.items as any[];
    expect(bAccounts.map((item) => item.name)).toEqual(['B current']); // ISO-4
    const bTransactions = (await userB.call('GET', '/api/v1/transactions?from=2026-01-01&to=2026-12-31')).body.items as any[];
    expect(bTransactions.every((tx) => tx.id !== aTransaction)).toBe(true);
    expect((await userB.call('GET', '/api/v1/summary?at=2026-03-31')).body.netWorth_minor).toBe(5000);

    expect((await userA.call('GET', '/api/v1/summary?at=2026-03-31')).body).toEqual(aSummaryBefore);
  });
});

describe('GT-70 · a USD workspace', () => {
  test('gives identical numbers, labelled USD', async () => {
    const client = await verifiedUser(harness, 'gt70@example.com');
    await setUpGt03(client, 'USD');
    const summary = (await client.call('GET', '/api/v1/summary?at=2026-03-31')).body;
    expect(summary.currency).toBe('USD');
    expect(summary.netWorth_minor).toBe(504240);
    expect(summary.safeToSpend.value_minor).toBe(304240);
  });
});
