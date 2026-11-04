/**
 * Session idle limits and "keep me signed in" (AD-14), per-account login throttling (BR-01.3,
 * AC-01.5), the audit view (FR-19), and account deletion through to the purge (§8.6, GAP-5, AC-01.6).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { purgeDeletedWorkspaces } from '@fintrack/db';
import { delaySeconds } from '../src/login-throttle.ts';
import { Client, key, PASSWORD, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;
const nextEmail = () => `security-${++counter}@example.com`;
const sql = (text: string, values: unknown[] = []) => harness.database.pool.query(text, values);
const forUser = `"userId" = (SELECT id FROM auth."user" WHERE email = $1)`;

async function withWorkspace(email: string) {
  const client = await verifiedUser(harness, email);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
  return client;
}

describe('session idle limits (AD-14)', () => {
  const idle = (email: string, age: string) => sql(`UPDATE auth.session SET "lastActiveAt" = now() - $2::interval WHERE ${forUser}`, [email, age]);

  test('by default a session ends after 30 idle minutes, however recent its last refresh', async () => {
    const email = nextEmail();
    const client = await withWorkspace(email);
    await idle(email, '29 minutes');
    expect((await client.call('GET', '/api/v1/workspace')).status).toBe(200);
    await idle(email, '31 minutes');
    expect((await client.call('GET', '/api/v1/workspace')).status).toBe(401);
    expect((await sql(`SELECT 1 FROM auth.session WHERE ${forUser}`, [email])).rowCount).toBe(0);
  });

  test('activity moves the idle clock forward', async () => {
    const email = nextEmail();
    const client = await withWorkspace(email);
    await idle(email, '20 minutes');
    await client.call('GET', '/api/v1/workspace');
    const seconds = await sql(`SELECT extract(epoch FROM now() - "lastActiveAt")::int AS s FROM auth.session WHERE ${forUser}`, [email]);
    expect(seconds.rows[0].s).toBeLessThan(60);
  });

  test('"keep me signed in" allows 14 idle days, and only when asked for', async () => {
    const email = nextEmail();
    const client = await withWorkspace(email);
    expect((await sql(`SELECT "keepSignedIn" FROM auth.session WHERE ${forUser}`, [email])).rows[0].keepSignedIn).toBe(false);

    const kept = new Client(harness);
    expect((await kept.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD, rememberMe: true } })).status).toBe(200);
    await sql(`DELETE FROM auth.session WHERE ${forUser} AND NOT "keepSignedIn"`, [email]);
    await idle(email, '13 days');
    expect((await kept.call('GET', '/api/v1/workspace')).status).toBe(200);
    await idle(email, '15 days');
    expect((await kept.call('GET', '/api/v1/workspace')).status).toBe(401);
    expect(client.cookie).not.toBe('');
  });

  test('the 30-day absolute limit still holds with "keep me signed in"', async () => {
    const email = nextEmail();
    await verifiedUser(harness, email);
    const kept = new Client(harness);
    await kept.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD, rememberMe: true } });
    await sql(`UPDATE auth.session SET "createdAt" = now() - interval '31 days' WHERE ${forUser}`, [email]);
    expect((await kept.call('GET', '/api/v1/workspace')).status).toBe(401);
  });
});

describe('per-account login throttling (BR-01.3, AC-01.5)', () => {
  /** A new source address each time, so that only the per-account limit is in play. */
  const attempt = (email: string, password: string) => new Client(harness).call('POST', '/api/auth/sign-in/email', { body: { email, password } });
  const wrong = 'not the right password';

  test('delays start at the 5th failure, double, and stop at 15 minutes', () => {
    expect([1, 4, 5, 6, 7, 20].map(delaySeconds)).toEqual([0, 0, 30, 60, 120, 900]);
  });

  test('from the 5th failure even the right password must wait; the wait passes, and success clears the count', async () => {
    const email = nextEmail();
    await verifiedUser(harness, email);
    for (let i = 0; i < 4; i += 1) expect((await attempt(email, wrong)).status).toBe(401);
    expect((await attempt(email, wrong)).status).toBe(401);
    const blocked = await attempt(email, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

    await sql("UPDATE auth.login_throttle SET locked_until = now() - interval '1 second'");
    expect((await attempt(email, PASSWORD)).status).toBe(200);
    expect((await attempt(email, wrong)).status).toBe(401);
    expect((await attempt(email, PASSWORD)).status).toBe(200);
  });

  test('an unknown address behaves the same, and the table holds no address (AC-01.2)', async () => {
    const email = `nobody-${++counter}@example.com`;
    for (let i = 0; i < 5; i += 1) expect((await attempt(email, wrong)).status).toBe(401);
    expect((await attempt(email, wrong)).status).toBe(429);
    const rows = await sql('SELECT key FROM auth.login_throttle');
    expect(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.key))).toBe(true);
  });

  test('an old failure no longer counts after 15 minutes', async () => {
    const email = nextEmail();
    await verifiedUser(harness, email);
    for (let i = 0; i < 4; i += 1) await attempt(email, wrong);
    await sql("UPDATE auth.login_throttle SET first_failure_at = now() - interval '16 minutes'");
    await attempt(email, wrong);
    expect((await attempt(email, PASSWORD)).status).toBe(200);
  });
});

describe('the audit view (FR-19)', () => {
  test('shows sign-ins, failed sign-ins and financial events with no amounts; pages through; stays private', async () => {
    const email = nextEmail();
    const client = await withWorkspace(email);
    await new Client(harness).call('POST', '/api/auth/sign-in/email', { body: { email, password: 'not the right password' } });
    const categories = (await client.call('GET', '/api/v1/categories')).body.items;
    const food = categories.find((c: any) => c.name === 'Food').id;
    const account = (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name: 'Current', type: 'current', openingDate: '2026-03-01', openingAmount_minor: 123456 } })).body.id;
    for (let i = 0; i < 52; i += 1) {
      await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: '2026-03-02', accountId: account, description: 'secret text', lines: [{ categoryId: food, amount_minor: 111 }] } });
    }

    const first = (await client.call('GET', '/api/v1/audit')).body;
    expect(first.items).toHaveLength(50);
    expect(first.items[0].type).toBe('transaction.created');
    expect(JSON.stringify(first)).not.toMatch(/secret text|123456|"111"/);
    const second = (await client.call('GET', `/api/v1/audit?before=${first.nextBefore}`)).body;
    expect(second.nextBefore).toBeNull();
    const types = second.items.map((item: any) => item.type);
    expect(types).toEqual(expect.arrayContaining(['auth.login', 'auth.login_failed', 'workspace.created', 'account.created']));
    expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(first.items.length + second.items.length);

    const other = await withWorkspace(nextEmail());
    const seen = (await other.call('GET', '/api/v1/audit')).body.items.map((item: any) => item.type).sort();
    expect(seen).toEqual(['auth.login', 'workspace.created']);
  });
});

describe('account deletion (§8.6, GAP-5, AC-01.6)', () => {
  const signIn = async (email: string) => {
    const client = new Client(harness);
    expect((await client.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(200);
    return client;
  };
  const request = (client: Client) => client.call('POST', '/api/v1/workspace/deletion', { key: key() });

  async function fullUser(email: string) {
    const client = await withWorkspace(email);
    const categories = (await client.call('GET', '/api/v1/categories')).body.items;
    const food = categories.find((c: any) => c.name === 'Food').id;
    const account = (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name: 'Current', type: 'current', openingDate: '2026-03-01', openingAmount_minor: 100000 } })).body.id;
    const purchase = (await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: '2026-03-02', accountId: account, lines: [{ categoryId: food, amount_minor: 1000 }] } })).body;
    await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'refund', date: '2026-03-03', accountId: account, refundOfId: purchase.id, lines: [{ categoryId: food, amount_minor: 100 }] } });
    expect((await client.call('POST', '/api/v1/reconciliations', { key: key(), body: { accountId: account, statementDate: '2026-03-31', statementBalance_minor: 99100, transactionIds: [purchase.id] } })).status).toBe(422);
    const items = (await client.call('POST', '/api/v1/reconciliations/preview', { body: { accountId: account, statementDate: '2026-03-31', statementBalance_minor: 99100, transactionIds: [] } })).body.items;
    const done = await client.call('POST', '/api/v1/reconciliations', { key: key(), body: { accountId: account, statementDate: '2026-03-31', statementBalance_minor: 99100, transactionIds: items.filter((i: any) => !i.automatic).map((i: any) => i.id) } });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    return { client, account };
  }

  test('it needs a recent sign-in', async () => {
    const email = nextEmail();
    const client = await withWorkspace(email);
    await sql(`UPDATE auth.session SET "createdAt" = now() - interval '11 minutes' WHERE ${forUser}`, [email]);
    const stale = await request(client);
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    expect((await client.call('GET', '/api/v1/workspace')).body.status).toBe('active');
  });

  test('a request ends every session, sends a notice and blocks everything except cancel, export and status; cancelling restores it all', async () => {
    const email = nextEmail();
    const { client } = await fullUser(email);
    const other = await signIn(email);
    const result = await request(client);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.status).toBe('deletion_pending');
    const days = (Date.parse(result.body.purgeAfter) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect((await client.call('GET', '/api/v1/workspace')).status).toBe(401);
    expect((await other.call('GET', '/api/v1/workspace')).status).toBe(401);
    expect(harness.emails.some((sent) => sent.to === email && sent.kind === 'deletion-requested')).toBe(true);

    const back = await signIn(email);
    expect((await back.call('GET', '/api/v1/workspace')).body.status).toBe('deletion_pending');
    for (const path of ['/api/v1/accounts', '/api/v1/categories', '/api/v1/summary', '/api/v1/audit']) {
      expect((await back.call('GET', path)).body.code, path).toBe('DELETION_PENDING');
    }
    expect((await back.call('POST', '/api/v1/categories', { key: key(), body: { name: 'x', kind: 'expense' } })).body.code).toBe('DELETION_PENDING');
    expect((await back.call('POST', '/api/v1/exports')).status).toBe(200);

    const cancelled = await back.call('POST', '/api/v1/workspace/deletion/cancel', { key: key() });
    expect(cancelled.body).toMatchObject({ status: 'active', purgeAfter: null });
    expect((await back.call('GET', '/api/v1/accounts')).status).toBe(200);
    expect((await back.call('POST', '/api/v1/workspace/deletion/cancel', { key: key() })).body.code).toBe('INVALID_STATE');

    await purgeDeletedWorkspaces(harness.database.pool);
    expect((await back.call('GET', '/api/v1/accounts')).body.items).toHaveLength(1);
  });

  test('after 7 days the purge removes every row and the login, keeps an audit trail without personal data, and leaves other users alone', async () => {
    const email = nextEmail();
    const { client, account } = await fullUser(email);
    const bystanderEmail = nextEmail();
    const bystander = (await fullUser(bystanderEmail)).client;
    const before = (await bystander.call('GET', '/api/v1/summary')).body;
    const userId = (await sql('SELECT id FROM auth."user" WHERE email = $1', [email])).rows[0].id;
    const workspaceId = (await sql('SELECT workspace_id FROM fin.memberships WHERE user_id = $1', [userId])).rows[0].workspace_id;
    await request(client);

    // Six days in: nothing happens yet, and the user can still cancel.
    await sql("UPDATE fin.workspaces SET deletion_requested_at = now() - interval '6 days' WHERE id = $1", [workspaceId]);
    expect((await purgeDeletedWorkspaces(harness.database.pool)).purged).toBe(0);
    await sql("UPDATE fin.workspaces SET deletion_requested_at = now() - interval '8 days' WHERE id = $1", [workspaceId]);
    const late = await signIn(email);
    expect((await late.call('POST', '/api/v1/workspace/deletion/cancel', { key: key() })).body.code).toBe('INVALID_STATE');

    expect((await purgeDeletedWorkspaces(harness.database.pool)).purged).toBe(1);

    for (const table of ['memberships', 'ledger_accounts', 'accounts', 'categories', 'payees', 'transactions', 'postings', 'transaction_versions', 'reconciliations', 'reconciliation_items', 'idempotency_records']) {
      const left = await sql(`SELECT count(*)::int AS n FROM fin.${table} WHERE workspace_id = $1`, [workspaceId]);
      expect(left.rows[0].n, table).toBe(0);
    }
    expect((await sql('SELECT 1 FROM fin.consent_records WHERE user_id = $1', [userId])).rowCount).toBe(0);
    expect((await sql('SELECT 1 FROM auth."user" WHERE id = $1', [userId])).rowCount).toBe(0);
    expect((await sql('SELECT 1 FROM auth.session WHERE "userId" = $1', [userId])).rowCount).toBe(0);
    expect((await sql('SELECT 1 FROM auth.account WHERE "userId" = $1', [userId])).rowCount).toBe(0);
    expect((await sql('SELECT 1 FROM fin.accounts WHERE ledger_account_id = $1', [account])).rowCount).toBe(0);

    const tombstone = (await sql('SELECT name, status, timezone FROM fin.workspaces WHERE id = $1', [workspaceId])).rows[0];
    expect(tombstone).toEqual({ name: 'deleted', status: 'purged', timezone: 'UTC' });
    const trail = await sql('SELECT event_type, metadata, ip_prefix FROM fin.audit_events WHERE workspace_id = $1', [workspaceId]);
    expect(trail.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining(['account.deletion_requested', 'account.purged']));
    expect(JSON.stringify(trail.rows)).not.toContain(email);

    expect((await late.call('GET', '/api/v1/workspace')).status).toBe(401);
    expect((await new Client(harness).call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(401);
    expect((await bystander.call('GET', '/api/v1/summary')).body).toEqual(before);
    expect((await bystander.call('GET', '/api/v1/accounts')).body.items).toHaveLength(1);

    // The address is free again.
    await verifiedUser(harness, email);
  });

  test('the application role still cannot delete; the purge role is confined to the workspace it names', async () => {
    const victim = nextEmail();
    await fullUser(victim);
    const db = await harness.database.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE fin_maintenance');
      await db.query("SELECT set_config('app.workspace_id', '00000000-0000-7000-8000-000000000000', true)");
      for (const table of ['accounts', 'categories', 'memberships', 'reconciliations']) {
        expect((await db.query(`DELETE FROM fin.${table}`)).rowCount, table).toBe(0);
      }
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE fin_app');
      await expect(db.query('DELETE FROM fin.accounts')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });
});
