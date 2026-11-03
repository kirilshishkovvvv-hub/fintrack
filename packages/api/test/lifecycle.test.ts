/**
 * The transaction lifecycle through the API (Stage 1 §9.3, §9.7, FR-19): edits with version
 * history (LR-10, AC-19.2, GT-43), void and restore (GT-44), the trash (AC-19.1, OD-05),
 * undo (GAP-4), purging (GAP-2), optimistic versions and isolation between users.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { purgeExpiredTrash } from '@fintrack/db';
import { key, startHarness, verifiedUser, type Client, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let userCounter = 0;

/** A verified user with a EUR workspace and a Current account opened on 1 Mar with 1,000.00. */
async function setUp() {
  const client = await verifiedUser(harness, `lifecycle-${++userCounter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((item) => item.name === name)!.id;
  const current = (await client.call('POST', '/api/v1/accounts', {
    key: key(),
    body: { name: 'Current', type: 'current', openingDate: '2026-03-01', openingAmount_minor: 100000 },
  })).body.id as string;
  const expense = (amount: number, date = '2026-03-10', name = 'Food') => ({
    kind: 'expense',
    date,
    accountId: current,
    lines: [{ categoryId: category(name), amount_minor: amount }],
  });
  const create = async (body: unknown) => {
    const result = await client.call('POST', '/api/v1/transactions', { key: key(), body });
    expect(result.status).toBe(201);
    return result.body;
  };
  return { client, current, category, expense, create };
}

const balance = async (client: Client) => ((await client.call('GET', '/api/v1/accounts')).body.items as any[])[0].balance_minor as number;
const summary = async (client: Client) => (await client.call('GET', '/api/v1/summary?at=2026-03-31')).body;
const patch = (client: Client, id: string, version: number | null, body: unknown) =>
  client.call('PATCH', `/api/v1/transactions/${id}`, { body, ...(version === null ? {} : { headers: { 'if-match': `"${version}"` } }) });

describe('editing (E-38, LR-10)', () => {
  test('an edit applies only the difference and records the old and new values (AC-19.2)', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    expect(food.version).toBe(1);

    const edited = await patch(client, food.id, 1, expense(5460));
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    expect(await balance(client)).toBe(94540);

    const detail = (await client.call('GET', `/api/v1/transactions/${food.id}`)).body;
    expect(detail.versions.map((entry: any) => entry.changeType)).toEqual(['create', 'edit']);
    const amounts = (snapshot: any) => snapshot.lines.map((line: any) => line.amount_minor).sort((a: number, b: number) => a - b);
    expect(amounts(detail.versions[1].before)).toEqual([-4560, 4560]);
    expect(amounts(detail.versions[1].after)).toEqual([-5460, 5460]);

    const events = await harness.database.pool.query("SELECT 1 FROM fin.audit_events WHERE event_type = 'transaction.edited' AND object_id = $1", [food.id]);
    expect(events.rowCount).toBe(1);
  });

  test('GT-43: moving the date to 1 Apr moves the expense to April, with one history entry', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(5000, '2026-03-31'));
    expect((await patch(client, food.id, 1, expense(5000, '2026-04-01'))).status).toBe(200);
    const march = (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-31')).body.items;
    const april = (await client.call('GET', '/api/v1/transactions?from=2026-04-01&to=2026-04-30')).body.items;
    expect(march.some((tx: any) => tx.id === food.id)).toBe(false);
    expect(april.map((tx: any) => tx.id)).toEqual([food.id]);
    const detail = (await client.call('GET', `/api/v1/transactions/${food.id}`)).body;
    expect(detail.versions.filter((entry: any) => entry.changeType === 'edit')).toHaveLength(1);
  });

  test('an edit can change the kind, e.g. an expense that was really a transfer', async () => {
    const { client, current, expense, create } = await setUp();
    const savings = (await client.call('POST', '/api/v1/accounts', {
      key: key(),
      body: { name: 'Savings', type: 'savings', openingDate: '2026-03-01' },
    })).body.id;
    const tx = await create(expense(20000));
    const result = await patch(client, tx.id, 1, { kind: 'transfer', date: '2026-03-10', fromAccountId: current, toAccountId: savings, amount_minor: 20000 });
    expect(result.status).toBe(200);
    expect(result.body.kind).toBe('transfer');
    const figures = await summary(client);
    expect(figures.netWorth_minor).toBe(100000);
    expect(figures.cashBalance_minor).toBe(100000);
  });

  test('edits need the current version; a stale or missing one changes nothing', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    const missing = await patch(client, food.id, null, expense(100));
    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe('VERSION_REQUIRED');
    expect((await patch(client, food.id, 1, expense(5000))).status).toBe(200);
    const stale = await patch(client, food.id, 1, expense(6000));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(await balance(client)).toBe(95000);
  });

  test('an edit that breaks a ledger rule is rejected and leaves the transaction unchanged', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    const future = await patch(client, food.id, 1, expense(4560, '2099-01-01'));
    expect(future.status).toBe(422);
    const beforeOpening = await patch(client, food.id, 1, expense(4560, '2026-02-01'));
    expect(beforeOpening.status).toBe(422);
    const detail = (await client.call('GET', `/api/v1/transactions/${food.id}`)).body;
    expect(detail.version).toBe(1);
    expect(detail.date).toBe('2026-03-10');
    expect(await balance(client)).toBe(95440);
  });

  test('opening balances are not edited here, and only posted transactions can be edited', async () => {
    const { client, expense, create } = await setUp();
    const opening = (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-01')).body.items[0];
    expect(opening.kind).toBe('opening_balance');
    expect((await patch(client, opening.id, 1, expense(100))).body.code).toBe('NOT_EDITABLE');

    const food = await create(expense(4560));
    await client.call('POST', `/api/v1/transactions/${food.id}/void`, { key: key() });
    const result = await patch(client, food.id, 2, expense(100));
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('INVALID_STATE');
  });
});

describe('void, trash and restore (§9.3)', () => {
  test('GT-44: voiding removes every effect, restoring brings back exactly the same figures', async () => {
    const { client, expense, create } = await setUp();
    const rent = await create(expense(60000, '2026-03-25', 'Rent'));
    const before = await summary(client);

    const voided = await client.call('POST', `/api/v1/transactions/${rent.id}/void`, { key: key() });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('voided');
    expect(await balance(client)).toBe(100000);
    const list = (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-31')).body.items;
    expect(list.find((tx: any) => tx.id === rent.id).status).toBe('voided');

    const restored = await client.call('POST', `/api/v1/transactions/${rent.id}/restore`, { key: key() });
    expect(restored.status).toBe(200);
    expect(await summary(client)).toEqual(before);
    const again = await client.call('POST', `/api/v1/transactions/${rent.id}/restore`, { key: key() });
    expect(again.body.code).toBe('INVALID_STATE');
  });

  test('AC-19.1: deleting then restoring yields identical balances; the trash shows the purge date', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    const before = await summary(client);

    expect((await client.call('DELETE', `/api/v1/transactions/${food.id}`)).status).toBe(428);
    const trashed = await client.call('DELETE', `/api/v1/transactions/${food.id}`, { headers: { 'if-match': '1' } });
    expect(trashed.status).toBe(200);
    expect(await balance(client)).toBe(100000);
    const list = (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-31')).body.items;
    expect(list.some((tx: any) => tx.id === food.id)).toBe(false);
    const trash = (await client.call('GET', '/api/v1/trash')).body.items;
    expect(trash.map((tx: any) => tx.id)).toEqual([food.id]);
    const days = (Date.parse(trash[0].purgeAfter) - Date.parse(trash[0].trashedAt)) / 86_400_000;
    expect(days).toBe(30);

    expect((await client.call('POST', `/api/v1/transactions/${food.id}/restore`, { key: key() })).status).toBe(200);
    expect(await summary(client)).toEqual(before);
    const history = (await client.call('GET', `/api/v1/transactions/${food.id}`)).body.versions.map((entry: any) => entry.changeType);
    expect(history).toEqual(['create', 'trash', 'restore']);
  });

  test('a repeated void with the same key is answered once', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    const idem = key();
    const first = await client.call('POST', `/api/v1/transactions/${food.id}/void`, { key: idem });
    const second = await client.call('POST', `/api/v1/transactions/${food.id}/void`, { key: idem });
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body).toEqual(first.body);
  });
});

describe('undo (GAP-4)', () => {
  test('undoing a create moves it to the trash; undoing an edit returns the previous version', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    expect(food.undo.expiresInSeconds).toBe(10);
    const edited = (await patch(client, food.id, 1, expense(9999))).body;
    const undone = await client.call('POST', `/api/v1/undo/${edited.undo.token}`, { key: key() });
    expect(undone.status).toBe(200);
    expect(await balance(client)).toBe(95440);
    const history = (await client.call('GET', `/api/v1/transactions/${food.id}`)).body.versions.map((entry: any) => entry.changeType);
    expect(history).toEqual(['create', 'edit', 'edit']);

    const other = await create(expense(1000));
    expect((await client.call('POST', `/api/v1/undo/${other.undo.token}`, { key: key() })).body.status).toBe('trashed');
    expect(await balance(client)).toBe(95440);
  });

  test('undoing a delete restores it', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    const trashed = (await client.call('DELETE', `/api/v1/transactions/${food.id}`, { headers: { 'if-match': '1' } })).body;
    expect((await client.call('POST', `/api/v1/undo/${trashed.undo.token}`, { key: key() })).body.status).toBe('posted');
    expect(await balance(client)).toBe(95440);
  });

  test('only the latest change can be undone, and only once', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    await patch(client, food.id, 1, expense(5000));
    const stale = await client.call('POST', `/api/v1/undo/${food.undo.token}`, { key: key() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('UNDO_EXPIRED');

    const edited = (await patch(client, food.id, 2, expense(6000))).body;
    expect((await client.call('POST', `/api/v1/undo/${edited.undo.token}`, { key: key() })).status).toBe(200);
    expect((await client.call('POST', `/api/v1/undo/${edited.undo.token}`, { key: key() })).body.code).toBe('UNDO_EXPIRED');
  });

  test('after the undo window, the action can no longer be undone', async () => {
    const { client, expense, create } = await setUp();
    const food = await create(expense(4560));
    // Test-only: age the version entry. The append-only trigger is lifted for this one statement.
    const pool = harness.database.pool;
    await pool.query('ALTER TABLE fin.transaction_versions DISABLE TRIGGER transaction_versions_append_only');
    await pool.query("UPDATE fin.transaction_versions SET changed_at = now() - interval '16 seconds' WHERE id = $1", [food.undo.token]);
    await pool.query('ALTER TABLE fin.transaction_versions ENABLE TRIGGER transaction_versions_append_only');
    const result = await client.call('POST', `/api/v1/undo/${food.undo.token}`, { key: key() });
    expect(result.body.code).toBe('UNDO_EXPIRED');
    expect(await balance(client)).toBe(95440);
  });
});

describe('purging the trash (FR-19, OD-05, GAP-2)', () => {
  test('after 30 days a trashed transaction is purged; a refund of it keeps its amount and loses only the link', async () => {
    const { client, current, category, expense, create } = await setUp();
    const purchase = await create(expense(8000, '2026-03-05', 'Shopping'));
    const refund = await create({ kind: 'refund', date: '2026-03-08', accountId: current, refundOfId: purchase.id, lines: [{ categoryId: category('Shopping'), amount_minor: 2000 }] });
    const recent = await create(expense(1000));
    await client.call('DELETE', `/api/v1/transactions/${purchase.id}`, { headers: { 'if-match': '1' } });
    await client.call('DELETE', `/api/v1/transactions/${recent.id}`, { headers: { 'if-match': '1' } });
    const pool = harness.database.pool;
    await pool.query("UPDATE fin.transactions SET trashed_at = now() - interval '31 days' WHERE id = $1", [purchase.id]);

    await purgeExpiredTrash(pool);

    expect((await client.call('GET', `/api/v1/transactions/${purchase.id}`)).status).toBe(404);
    expect((await client.call('GET', '/api/v1/trash')).body.items.map((tx: any) => tx.id)).toEqual([recent.id]);
    const kept = (await client.call('GET', `/api/v1/transactions/${refund.id}`)).body;
    expect(kept.refundOfId).toBeNull();
    expect(await balance(client)).toBe(102000);
    const events = await pool.query(
      `SELECT event_type, object_id FROM fin.audit_events WHERE object_id = ANY($1) AND event_type LIKE 'transaction.%' AND user_id IS NULL ORDER BY event_type`,
      [[purchase.id, refund.id]],
    );
    expect(events.rows).toEqual([
      { event_type: 'transaction.purged', object_id: purchase.id },
      { event_type: 'transaction.refund_link_cleared', object_id: refund.id },
    ]);
    const content = await pool.query('SELECT count(*)::int AS n FROM fin.transaction_versions WHERE transaction_id = $1', [purchase.id]);
    expect(content.rows[0].n).toBe(0);
  });
});

describe('isolation (GT-59)', () => {
  test("another user can't edit, void, trash, restore or undo someone else's transaction", async () => {
    const owner = await setUp();
    const food = await owner.create(owner.expense(4560));
    const intruder = await setUp();
    const id = food.id;
    expect((await patch(intruder.client, id, 1, intruder.expense(1))).status).toBe(404);
    expect((await intruder.client.call('DELETE', `/api/v1/transactions/${id}`, { headers: { 'if-match': '1' } })).status).toBe(404);
    expect((await intruder.client.call('POST', `/api/v1/transactions/${id}/void`, { key: key() })).status).toBe(404);
    expect((await intruder.client.call('POST', `/api/v1/transactions/${id}/restore`, { key: key() })).status).toBe(404);
    expect((await intruder.client.call('POST', `/api/v1/undo/${food.undo.token}`, { key: key() })).body.code).toBe('UNDO_EXPIRED');
    const detail = (await owner.client.call('GET', `/api/v1/transactions/${id}`)).body;
    expect(detail.version).toBe(1);
    expect(detail.status).toBe('posted');
  });
});
