/**
 * CSV import through the API (FR-16, Stage 1 §9.6): GT-09, GT-35, GT-36, GT-38 (ledger part),
 * GT-39 (b), GT-71 (import rows), AC-16.1, 16.2, 16.4, 16.5, BR-16.5 to BR-16.8, isolation (ISO-5)
 * and the NFR-03 time limit. Planned-occurrence matching (GT-37) joins with Stage 5.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { purgeExpiredTrash } from '@fintrack/db';
import { key, ORIGIN, startHarness, verifiedUser, type Client, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;

const SETTINGS = {
  encoding: 'utf-8',
  delimiter: ',',
  decimalSeparator: '.',
  dateFormat: 'YYYY-MM-DD',
  headerRow: 0,
  mapping: { date: 0, amount: 1, description: 2 },
};
const WITH_CURRENCY = { ...SETTINGS, mapping: { ...SETTINGS.mapping, currency: 3 } };

/** B0: Current 1,000, Cash wallet 100, Savings 2,000. */
async function setUpB0() {
  const email = `import-${++counter}@example.com`;
  const client = await verifiedUser(harness, email);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((item) => item.name === name)!.id;
  const account = async (name: string, type: string, opening: number) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: '2026-03-01', openingAmount_minor: opening } })).body.id as string;
  const current = await account('Current', 'current', 100000);
  await account('Cash wallet', 'cash', 10000);
  const savings = await account('Savings', 'savings', 200000);
  return { client, email, category, current, savings };
}

function send(client: Client, path: string, fields: Record<string, string>, file: string | Uint8Array, idem = key()) {
  const form = new FormData();
  form.set('file', new File([file as Uint8Array<ArrayBuffer>], 'statement.csv'));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { origin: ORIGIN, cookie: client.cookie, 'x-forwarded-for': client.ip, 'idempotency-key': idem };
  return harness.handle(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: form }));
}

async function createBatch(client: Client, accountId: string, csv: string, settings: unknown = SETTINGS) {
  const response = await send(client, '/api/v1/imports', { accountId, settings: JSON.stringify(settings) }, csv);
  const body = (await response.json()) as any;
  expect(response.status, JSON.stringify(body)).toBe(201);
  return (await client.call('GET', `/api/v1/imports/${body.id}`)).body;
}

const csv = (...rows: [string, string, string, string?][]) => `Date,Amount,Description,Currency\n${rows.map(([date, amount, description, currency]) => [date, amount, description, currency ?? ''].join(',')).join('\n')}\n`;
const confirm = (client: Client, id: string, body: unknown = { confirmCurrency: true }, idem = key()) => client.call('POST', `/api/v1/imports/${id}/confirm`, { key: idem, body });
const undo = (client: Client, id: string, body: unknown = {}) => client.call('POST', `/api/v1/imports/${id}/undo`, { key: key(), body });
const decide = (client: Client, batch: any, decisions: unknown[]) =>
  client.call('PATCH', `/api/v1/imports/${batch.id}/rows`, { body: { decisions }, headers: { 'if-match': String(batch.version) } });
const balances = async (client: Client) => Object.fromEntries(((await client.call('GET', '/api/v1/accounts')).body.items as any[]).map((a) => [a.name, a.balance_minor]));
const summary = async (client: Client, at = '2026-03-31') => (await client.call('GET', `/api/v1/summary?at=${at}`)).body;
const march = async (client: Client) => (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-12-31')).body.items.filter((tx: any) => tx.kind !== 'opening_balance');

describe('preview (FR-16 steps 2 and 3)', () => {
  test('AC-16.5: detects a Windows-1251 file, stores nothing, and follows the choices the user changes', async () => {
    const { client } = await setUpB0();
    const bytes = new Uint8Array([...'Дата;Основание;Сума\n12.03.2026;Плащане на наем за март;-600,00\n'].map((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
    }));
    const before = await harness.database.pool.query('SELECT count(*)::int AS n FROM fin.import_batches');
    const response = await send(client, '/api/v1/imports/preview', {}, bytes);
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.settings).toMatchObject({ encoding: 'windows-1251', delimiter: ';', decimalSeparator: ',', dateFormat: 'DD.MM.YYYY', headerRow: 0 });
    expect(body.columns).toEqual(['Дата', 'Основание', 'Сума']);
    expect(body.sample[0]).toMatchObject({ date: '2026-03-12', amount_minor: -60000, description: 'Плащане на наем за март' });
    expect(body.hasCurrencyColumn).toBe(false);

    const changed = (await (await send(client, '/api/v1/imports/preview', { settings: JSON.stringify({ dateFormat: 'YYYY-MM-DD' }) }, bytes)).json()) as any;
    expect(changed.unreadable).toBe(1);
    expect((await harness.database.pool.query('SELECT count(*)::int AS n FROM fin.import_batches')).rows[0].n).toBe(before.rows[0].n);
  });

  test('BR-16.8: files over 5 MB or 10,000 rows are refused', async () => {
    const { client, current } = await setUpB0();
    const big = await send(client, '/api/v1/imports/preview', {}, new Uint8Array(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    const many = 'Date,Amount,Description\n' + Array.from({ length: 10_001 }, () => '2026-03-12,-1.00,x').join('\n');
    const response = await send(client, '/api/v1/imports', { accountId: current, settings: JSON.stringify(SETTINGS) }, many);
    expect(response.status).toBe(413);
  });
});

describe('duplicates (AC-16.1, AC-16.2)', () => {
  test('GT-35: identical rows, re-imports and overlapping files give the Stage 1 numbers', async () => {
    const { client, current } = await setUpB0();
    const coffee: [string, string, string] = ['2026-03-12', '-2.50', 'COFFEE BAR'];
    const lidl: [string, string, string] = ['2026-03-13', '-45.00', 'LIDL'];
    const files = [csv(coffee, coffee, lidl), csv(coffee, coffee, lidl), csv(lidl, ['2026-03-14', '-10.00', 'SHELL']), csv(coffee, coffee, coffee)];
    const expected = [{ new: 3 }, { duplicate: 3 }, { new: 1, duplicate: 1 }, { new: 1, duplicate: 2 }];
    for (const [index, file] of files.entries()) {
      const batch = await createBatch(client, current, file);
      expect(batch.counts).toEqual(expected[index]);
      const done = await confirm(client, batch.id);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    expect((await balances(client)).Current).toBe(93750);
    expect((await summary(client)).safeToSpend.value_minor).toBe(103750);
    const created = await march(client);
    expect(created).toHaveLength(5);
    expect(created.every((tx: any) => tx.origin === 'import')).toBe(true);
  });

  test('a skipped duplicate can be overridden, and the database itself refuses a double import', async () => {
    const { client, current } = await setUpB0();
    const file = csv(['2026-03-12', '-2.50', 'COFFEE']);
    await confirm(client, (await createBatch(client, current, file)).id);
    const again = await createBatch(client, current, file);
    await decide(client, again, [{ rowId: again.rows[0].id, decision: 'import' }]);
    expect((await confirm(client, again.id)).status).toBe(200);
    expect((await balances(client)).Current).toBe(99500);

    const pool = harness.database.pool;
    const row = (await pool.query(`SELECT workspace_id, account_id, batch_id, fingerprint, ordinal FROM fin.import_rows WHERE batch_id = $1`, [again.id])).rows[0];
    await expect(
      pool.query(
        `INSERT INTO fin.import_rows (id, workspace_id, batch_id, row_no, account_id, fingerprint, ordinal, classification, state)
         VALUES (gen_random_uuid(), $1, $2, 99, $3, $4, $5, 'new', 'imported')`,
        [row.workspace_id, row.batch_id, row.account_id, row.fingerprint, row.ordinal],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('possible duplicates (BR-16.4)', () => {
  async function gt36() {
    const b0 = await setUpB0();
    const manual = (await b0.client.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'expense', date: '2026-03-11', accountId: b0.current, description: 'Lidl', lines: [{ categoryId: b0.category('Food'), amount_minor: 4560 }] },
    })).body;
    const batch = await createBatch(b0.client, b0.current, csv(['2026-03-12', '-45.60', 'LIDL SOFIA']));
    expect(batch.rows[0]).toMatchObject({ classification: 'possible_duplicate', decision: null, candidateTransactionId: manual.id });
    return { ...b0, manual, batch };
  }

  test('GT-36: a decision is required; linking keeps one transaction, and undo unlinks it', async () => {
    const { client, batch, manual, current } = await gt36();
    const undecided = await confirm(client, batch.id);
    expect(undecided.body.code).toBe('DECISIONS_REQUIRED');
    expect(undecided.body.details.rowNos).toEqual([1]);
    await decide(client, batch, [{ rowId: batch.rows[0].id, decision: 'link' }]);
    expect((await confirm(client, batch.id)).status).toBe(200);
    expect(await march(client)).toHaveLength(1);
    expect((await balances(client)).Current).toBe(95440);
    const read = (await client.call('GET', `/api/v1/imports/${batch.id}`)).body;
    expect(read.rows[0]).toMatchObject({ state: 'imported', claimedTransactionId: manual.id, createdTransactionId: null });

    // A re-import is an exact duplicate, not a second link.
    expect((await createBatch(client, current, csv(['2026-03-12', '-45.60', 'LIDL SOFIA']))).counts).toEqual({ duplicate: 1 });

    expect((await undo(client, batch.id)).status).toBe(200);
    expect((await balances(client)).Current).toBe(95440);
    expect((await client.call('GET', `/api/v1/transactions/${manual.id}`)).body.status).toBe('posted');
  });

  test('GT-36: keeping both gives two expenses, and the decision is audited', async () => {
    const { client, batch } = await gt36();
    await decide(client, batch, [{ rowId: batch.rows[0].id, decision: 'import' }]);
    expect((await confirm(client, batch.id)).status).toBe(200);
    expect((await balances(client)).Current).toBe(90880);
    const audit = await harness.database.pool.query(`SELECT 1 FROM fin.audit_events WHERE event_type = 'import.kept_both' AND object_id = $1`, [batch.rows[0].id]);
    expect(audit.rowCount).toBe(1);
  });
});

describe('transfers (BR-16.5, E-16)', () => {
  test('GT-09: both sides imported make exactly one transfer; Income and Expenses stay 0', async () => {
    const { client, current, savings } = await setUpB0();
    const first = await createBatch(client, current, csv(['2026-03-12', '-200.00', 'Transfer to savings']));
    expect(first.rows[0]).toMatchObject({ classification: 'transfer', decision: null, counterAccountId: savings });
    await decide(client, first, [{ rowId: first.rows[0].id, decision: 'transfer' }]);
    expect((await confirm(client, first.id)).status).toBe(200);

    const second = await createBatch(client, savings, csv(['2026-03-12', '200.00', 'Transfer from current']));
    expect(second.rows[0]).toMatchObject({ classification: 'already_recorded', decision: 'link' });
    expect((await confirm(client, second.id)).status).toBe(200);

    const all = await march(client);
    expect(all.map((tx: any) => tx.kind)).toEqual(['transfer']);
    expect(await balances(client)).toMatchObject({ Current: 80000, Savings: 220000 });
    const figures = await summary(client);
    expect(figures.netWorth_minor).toBe(310000);
    expect(figures.safeToSpend.value_minor).toBe(90000);
  });

  test('when one side is already income, it becomes the one transfer, and undo puts it back', async () => {
    const { client, current, savings, category } = await setUpB0();
    const income = (await client.call('POST', '/api/v1/transactions', {
      key: key(),
      body: { kind: 'income', date: '2026-03-12', accountId: savings, description: 'Incoming', lines: [{ categoryId: category('Other income'), amount_minor: 20000 }] },
    })).body;
    const batch = await createBatch(client, current, csv(['2026-03-12', '-200.00', 'WIRE 123']));
    expect(batch.rows[0]).toMatchObject({ classification: 'transfer', candidateTransactionId: income.id, counterAccountId: savings });
    await decide(client, batch, [{ rowId: batch.rows[0].id, decision: 'transfer' }]);
    expect((await confirm(client, batch.id)).status).toBe(200);
    expect((await march(client)).map((tx: any) => [tx.id, tx.kind])).toEqual([[income.id, 'transfer']]);
    expect(await balances(client)).toMatchObject({ Current: 80000, Savings: 220000 });

    expect((await undo(client, batch.id)).status).toBe(200);
    expect((await march(client)).map((tx: any) => [tx.id, tx.kind, tx.description])).toEqual([[income.id, 'income', 'Incoming']]);
    expect(await balances(client)).toMatchObject({ Current: 100000, Savings: 220000 });
  });
});

describe('currencies (BR-23.4)', () => {
  test('GT-71: rows in another currency are rejected; the rest import', async () => {
    const { client, current } = await setUpB0();
    const batch = await createBatch(client, current, csv(['2026-03-12', '-45.00', 'Shop', 'EUR'], ['2026-03-13', '-20.00', 'Shop', 'USD'], ['2025-12-14', '-50.00', 'Shop', 'BGN']), WITH_CURRENCY);
    expect(batch.rows.map((row: any) => row.rejectReason)).toEqual([null, 'foreign_currency', 'foreign_currency']);
    expect(batch.currencyAssumed).toBe(false);
    const done = await confirm(client, batch.id, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.states).toEqual({ imported: 1, rejected: 2 });
    expect((await balances(client)).Current).toBe(95500);
    await expect(decide(client, batch, [{ rowId: batch.rows[1].id, decision: 'import' }]).then((r) => r.status)).resolves.toBe(409);
  });

  test('GT-71: without a currency column the user must confirm the amounts are in the workspace currency', async () => {
    const { client, current } = await setUpB0();
    const batch = await createBatch(client, current, csv(['2026-03-12', '-45.00', 'Shop']));
    expect(batch.currencyAssumed).toBe(true);
    expect((await confirm(client, batch.id, {})).body.code).toBe('CURRENCY_CONFIRM_REQUIRED');
    expect((await confirm(client, batch.id, { confirmCurrency: true })).status).toBe(200);
  });
});

describe('categories (FR-05, FR-16 step 8)', () => {
  test('uncategorized rows land in the visible system category; a chosen or learned category is used; a positive row in an expense category is a refund', async () => {
    const { client, current, category } = await setUpB0();
    await client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: '2026-03-02', accountId: current, description: 'SHELL  Sofia', lines: [{ categoryId: category('Transport'), amount_minor: 1 }] } });
    const batch = await createBatch(client, current, csv(['2026-03-12', '-10.00', 'shell sofia'], ['2026-03-13', '-5.00', 'UNKNOWN'], ['2026-03-14', '7.00', 'BACK'], ['2026-03-15', '30.00', 'MYSTERY']));
    expect(batch.rows[0].categoryId).toBe(category('Transport'));
    await decide(client, batch, [{ rowId: batch.rows[2].id, categoryId: category('Food') }]);
    expect((await confirm(client, batch.id)).status).toBe(200);
    const categories = (await client.call('GET', '/api/v1/categories')).body.items as any[];
    const names = new Map(categories.map((c) => [c.id, c.name]));
    const created = (await march(client)).filter((tx: any) => tx.origin === 'import').map((tx: any) => [tx.kind, names.get(tx.lines.find((l: any) => names.has(l.ledgerAccountId)).ledgerAccountId)]);
    expect(created.sort()).toEqual([['expense', 'Transport'], ['expense', 'Uncategorized'], ['income', 'Uncategorized income'], ['refund', 'Food']].sort());
  });
});

describe('undo (BR-16.6, AC-16.4)', () => {
  const file = () => csv(['2026-03-26', '2000.00', 'SALARY'], ['2026-03-26', '-45.00', 'FOOD'], ['2026-03-26', '-30.00', 'TRANSPORT'], ['2026-03-26', '-25.00', 'FOOD 2']);

  test('GT-38 (ledger part): undoing restores every figure, and the same file can then be imported again', async () => {
    const { client, current } = await setUpB0();
    const before = await summary(client);
    const batch = await createBatch(client, current, file());
    await confirm(client, batch.id);
    expect((await balances(client)).Current).toBe(290000);
    expect((await summary(client)).safeToSpend.value_minor).toBe(300000);
    const done = await undo(client, batch.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('undone');
    expect(await summary(client)).toEqual(before);
    expect((await undo(client, batch.id)).body.code).toBe('INVALID_STATE');
    expect((await createBatch(client, current, file())).counts).toEqual({ new: 4 });
  });

  test('GT-38 variant: blocked while reconciled, listing the locked transactions', async () => {
    const { client, current } = await setUpB0();
    const batch = await createBatch(client, current, file());
    await confirm(client, batch.id);
    const created = (await client.call('GET', `/api/v1/imports/${batch.id}`)).body.rows.map((row: any) => row.createdTransactionId);
    const done = await client.call('POST', '/api/v1/reconciliations', { key: key(), body: { accountId: current, statementDate: '2026-03-26', statementBalance_minor: 290000, transactionIds: created } });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const blocked = await undo(client, batch.id);
    expect(blocked.body.code).toBe('LOCKED_RECONCILED');
    expect(blocked.body.details.transactionIds.sort()).toEqual([...created].sort());
    await client.call('POST', `/api/v1/reconciliations/${done.body.id}/unlock`, { key: key() });
    expect((await undo(client, batch.id)).status).toBe(200);
    expect((await balances(client)).Current).toBe(100000);
  });

  test('BR-16.6: transactions edited after the import are listed for confirmation', async () => {
    const { client, current, category } = await setUpB0();
    const batch = await createBatch(client, current, csv(['2026-03-26', '-45.00', 'FOOD']));
    await confirm(client, batch.id);
    const txId = (await client.call('GET', `/api/v1/imports/${batch.id}`)).body.rows[0].createdTransactionId;
    await client.call('PATCH', `/api/v1/transactions/${txId}`, {
      headers: { 'if-match': '1' },
      body: { kind: 'expense', date: '2026-03-26', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 5000 }] },
    });
    const asked = await undo(client, batch.id);
    expect(asked.body.code).toBe('IMPORT_EDITED');
    expect(asked.body.details.transactionIds).toEqual([txId]);
    expect((await undo(client, batch.id, { confirmEdited: true })).status).toBe(200);
    expect((await balances(client)).Current).toBe(100000);
  });
});

describe('all or nothing (LR-03)', () => {
  test('GT-39 (b): an 800-row confirmation interrupted part-way saves nothing; a retry saves all 800; another changes nothing', async () => {
    const { client, current } = await setUpB0();
    const rows = Array.from({ length: 800 }, (_, i): [string, string, string] => ['2026-03-12', '-1.00', `ROW ${i}`]);
    const batch = await createBatch(client, current, csv(...rows));
    const pool = harness.database.pool;
    // Test-only: fail on the 301st row, inside the database transaction.
    await pool.query(`
      CREATE FUNCTION fin.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.description = 'ROW 300' THEN RAISE EXCEPTION 'interrupted'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail BEFORE INSERT ON fin.transactions FOR EACH ROW EXECUTE FUNCTION fin.test_fail();`);
    const idem = key();
    try {
      expect((await confirm(client, batch.id, { confirmCurrency: true }, idem)).status).toBe(500);
    } finally {
      await pool.query('DROP TRIGGER test_fail ON fin.transactions; DROP FUNCTION fin.test_fail();');
    }
    expect(await march(client)).toHaveLength(0);
    const after = (await client.call('GET', `/api/v1/imports/${batch.id}`)).body;
    expect(after.status).toBe('review');
    expect(after.states).toEqual({ pending: 800 });

    expect((await confirm(client, batch.id, { confirmCurrency: true }, idem)).status).toBe(200);
    expect(await march(client)).toHaveLength(800);
    const replay = await confirm(client, batch.id, { confirmCurrency: true }, idem);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await march(client)).toHaveLength(800);
    expect((await balances(client)).Current).toBe(100000 - 80000);
  }, 60_000);

  test('NFR-03: 2,000 rows are classified and confirmed within 10 seconds, with the raw file kept nowhere', async () => {
    const { client, current } = await setUpB0();
    const rows = Array.from({ length: 2000 }, (_, i): [string, string, string] => ['2026-03-12', '-1.00', `SHOP ${i}`]);
    const started = Date.now();
    const batch = await createBatch(client, current, csv(...rows));
    expect(batch.rowCount).toBe(2000);
    const done = await confirm(client, batch.id);
    const elapsed = Date.now() - started;
    expect(done.status).toBe(200);
    expect(done.body.states).toEqual({ imported: 2000 });
    expect(elapsed, `${elapsed} ms`).toBeLessThan(10_000);
    expect((await balances(client)).Current).toBe(100000 - 200000);
  }, 60_000);
});

describe('review, profiles and clean-up', () => {
  test('decisions need the current version, and a saved mapping can be read back', async () => {
    const { client, current } = await setUpB0();
    const response = await send(client, '/api/v1/imports', { accountId: current, settings: JSON.stringify(SETTINGS), saveProfileAs: 'My bank' }, csv(['2026-03-12', '-1.00', 'A']));
    expect(response.status).toBe(201);
    const profiles = (await client.call('GET', '/api/v1/import-profiles')).body.items;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: 'My bank', delimiter: ',', dateFormat: 'YYYY-MM-DD', mapping: SETTINGS.mapping });
    const batch = (await client.call('GET', `/api/v1/imports/${((await response.json()) as any).id}`)).body;
    expect((await decide(client, batch, [{ rowId: batch.rows[0].id, decision: 'skip' }])).status).toBe(200);
    const stale = await decide(client, batch, [{ rowId: batch.rows[0].id, decision: 'import' }]);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  test('a discarded or abandoned import leaves no effect and is removed after 7 days; the same idempotency key replays', async () => {
    const { client, current } = await setUpB0();
    const discarded = await createBatch(client, current, csv(['2026-03-12', '-1.00', 'A']));
    expect((await client.call('DELETE', `/api/v1/imports/${discarded.id}`)).body.status).toBe('discarded');
    expect((await balances(client)).Current).toBe(100000);
    expect((await confirm(client, discarded.id)).body.code).toBe('INVALID_STATE');
    const abandoned = await createBatch(client, current, csv(['2026-03-13', '-1.00', 'B']));
    const kept = await createBatch(client, current, csv(['2026-03-14', '-1.00', 'C']));
    await confirm(client, kept.id);
    const pool = harness.database.pool;
    await pool.query(`UPDATE fin.import_batches SET created_at = now() - interval '8 days' WHERE id = ANY($1)`, [[discarded.id, abandoned.id, kept.id]]);
    await purgeExpiredTrash(pool);
    const left = await pool.query('SELECT id FROM fin.import_batches WHERE id = ANY($1)', [[discarded.id, abandoned.id, kept.id]]);
    expect(left.rows.map((row) => row.id)).toEqual([kept.id]);
    expect((await pool.query('SELECT 1 FROM fin.import_rows WHERE batch_id = $1', [abandoned.id])).rowCount).toBe(0);
  });

  test('ISO-5: another user gets 404 on every import of someone else, and cannot import into their account', async () => {
    const owner = await setUpB0();
    const batch = await createBatch(owner.client, owner.current, csv(['2026-03-12', '-1.00', 'SECRET']));
    const other = await setUpB0();
    const c = other.client;
    expect((await c.call('GET', `/api/v1/imports/${batch.id}`)).status).toBe(404);
    expect((await decide(c, batch, [{ rowId: batch.rows[0].id, decision: 'skip' }])).status).toBe(404);
    expect((await confirm(c, batch.id)).status).toBe(404);
    expect((await undo(c, batch.id)).status).toBe(404);
    expect((await c.call('DELETE', `/api/v1/imports/${batch.id}`)).status).toBe(404);
    expect((await send(c, '/api/v1/imports', { accountId: owner.current, settings: JSON.stringify(SETTINGS) }, csv(['2026-03-12', '-1.00', 'X']))).status).toBe(404);
    expect((await c.call('GET', '/api/v1/imports')).body.items).toEqual([]);
    expect(JSON.stringify((await c.call('GET', '/api/v1/import-profiles')).body)).not.toContain('SECRET');
  });
});
