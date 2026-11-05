/**
 * Data export (FR-17, Stage 2 §11.5): AC-17.1 to AC-17.3, the fresh-session rule (BR-01.5),
 * the audit event, isolation (GT-59), and opening balances staying in place (E-01).
 */
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inertText, toCsv } from '../src/export.ts';
import { key, ORIGIN, startHarness, verifiedUser, type Client, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

/** Reads a ZIP through its central directory, as an unzip tool does. */
function unzip(zip: Buffer): Record<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < count; i += 1) {
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files[name] = inflateRawSync(zip.subarray(start, start + packedSize));
    at += 46 + nameLength;
  }
  return files;
}

function parseCsv(data: Buffer): Record<string, string>[] {
  const text = data.toString('utf8').replace(/^﻿/, '');
  const rows: string[][] = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      rows.at(-1)!.push(cell);
      cell = '';
    } else if (c === '\n') {
      rows.at(-1)!.push(cell);
      cell = '';
      rows.push([]);
    } else if (c !== '\r') cell += c;
  }
  rows.pop();
  const [header, ...body] = rows;
  return body.map((row) => Object.fromEntries(header!.map((name, index) => [name, row[index]!])));
}

function exportZip(client: Client) {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: client.cookie, 'x-forwarded-for': client.ip };
  return harness.handle(new Request(`${ORIGIN}/api/v1/exports`, { method: 'POST', headers }));
}

let counter = 0;

async function setUp() {
  const email = `export-${++counter}@example.com`;
  const client = await verifiedUser(harness, email);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'Personal', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const food = categories.find((c) => c.name === 'Food')!.id;
  const current = (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name: 'Current', type: 'current', openingDate: '2026-03-01', openingAmount_minor: 100000 } })).body.id as string;
  const expense = (amount: number, description: string) =>
    client.call('POST', '/api/v1/transactions', { key: key(), body: { kind: 'expense', date: '2026-03-10', accountId: current, description, lines: [{ categoryId: food, amount_minor: amount }] } });
  return { client, email, current, expense };
}

describe('CSV cells', () => {
  test('text a spreadsheet would run is made inert; numeric columns are not escaped (AC-17.3)', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx']) expect(inertText(bad)).toBe(`'${bad}`);
    expect(inertText('Market')).toBe('Market');
    expect(toCsv(['a'], [[{ numeric: '-8.00' }], ['-8.00'], ['x,"y"']]).toString('utf8')).toBe('﻿a\r\n-8.00\r\n\'-8.00\r\n"x,""y"""\r\n');
  });
});

describe('export my data (FR-17)', () => {
  test('the package balances, matches the app and neutralizes formulas (AC-17.1, 17.2, 17.3)', async () => {
    const { client, expense } = await setUp();
    await expense(4560, '=HYPERLINK("http://evil.example")');
    await expense(1000, 'Λαϊκή αγορά, ☕');
    const voided = (await expense(777, 'voided')).body;
    await client.call('POST', `/api/v1/transactions/${voided.id}/void`, { key: key() });

    const response = await exportZip(client);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="fintrack-export-\d{4}-\d{2}-\d{2}\.zip"$/);
    const files = unzip(Buffer.from(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['accounts.csv', 'budgets.csv', 'categories.csv', 'data.json', 'goals.csv', 'payees.csv', 'planned.csv', 'reconciliations.csv', 'transactions.csv']);
    expect(files['transactions.csv']!.subarray(0, 3).toString('hex')).toBe('efbbbf');

    const lines = parseCsv(files['transactions.csv']!);
    const cents = (s: string) => Math.round(Number(s) * 100);
    const totals = new Map<string, number>();
    for (const line of lines) totals.set(line.transaction_id!, (totals.get(line.transaction_id!) ?? 0) + cents(line.amount!));
    expect([...totals.values()].every((total) => total === 0)).toBe(true);
    expect(lines.some((line) => line.description === `'=HYPERLINK("http://evil.example")`)).toBe(true);
    expect(lines.some((line) => line.description === 'Λαϊκή αγορά, ☕')).toBe(true);
    expect(lines.filter((line) => line.status === 'voided').length).toBe(2);
    expect(lines.every((line) => line.currency === 'EUR')).toBe(true);

    const app = (await client.call('GET', '/api/v1/accounts')).body.items[0];
    const [exported] = parseCsv(files['accounts.csv']!);
    expect(cents(exported!.balance!)).toBe(app.balance_minor);
    const posted = lines.filter((line) => line.status === 'posted' && line.target === 'Current').reduce((sum, line) => sum + cents(line.amount!), 0);
    expect(posted).toBe(app.balance_minor);

    const json = JSON.parse(files['data.json']!.toString('utf8'));
    expect(json.schemaVersion).toBe(1);
    expect(json.balances_minor[app.id]).toBe(app.balance_minor);
    expect(json.transactionVersions.length).toBeGreaterThanOrEqual(4);
    expect(json.consents.terms.accepted).toBe(true);
  });

  test('it needs a sign-in within the last 10 minutes, and each export is audited', async () => {
    const { client, email, current } = await setUp();
    const pool = harness.database.pool;
    const exports = async () =>
      (await pool.query(
        `SELECT count(*)::int AS n FROM fin.audit_events e JOIN fin.accounts a ON a.workspace_id = e.workspace_id
          WHERE a.ledger_account_id = $1 AND e.event_type = 'export.created'`,
        [current],
      )).rows[0].n;
    const setSignIn = (age: string) =>
      pool.query(`UPDATE auth.session SET "createdAt" = now() - $2::interval WHERE "userId" = (SELECT id FROM auth."user" WHERE email = $1)`, [email, age]);

    await setSignIn('11 minutes');
    const stale = await exportZip(client);
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe('REAUTH_REQUIRED');
    expect(await exports()).toBe(0);

    await setSignIn('0 minutes');
    expect((await exportZip(client)).status).toBe(200);
    expect(await exports()).toBe(1);
  });

  test("GT-59: an export holds only the user's own data; without a session or from another origin it's refused", async () => {
    const owner = await setUp();
    await owner.expense(1234, 'owner secret');
    const other = await setUp();
    const files = unzip(Buffer.from(await (await exportZip(other.client)).arrayBuffer()));
    for (const data of Object.values(files)) {
      expect(data.toString('utf8')).not.toContain('owner secret');
      expect(data.toString('utf8')).not.toContain(owner.current);
    }
    expect((await harness.handle(new Request(`${ORIGIN}/api/v1/exports`, { method: 'POST', headers: { origin: ORIGIN } }))).status).toBe(401);
    expect((await harness.handle(new Request(`${ORIGIN}/api/v1/exports`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: other.client.cookie } }))).status).toBe(403);
  });
});

describe('an encrypted export', () => {
  const PASSWORD_FOR_FILE = 'a long file password';

  /** Reads AE-2 entries by the published format, separately from the writer's code path. */
  function decrypt(zip: Buffer, password: string): Record<string, Buffer> {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < count; i += 1) {
      expect(zip.readUInt16LE(at + 10)).toBe(99);
      const size = zip.readUInt32LE(at + 20);
      const nameLength = zip.readUInt16LE(at + 28);
      const extraLength = zip.readUInt16LE(at + 30);
      const local = zip.readUInt32LE(at + 42);
      const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const entry = zip.subarray(start, start + size);
      const keys = pbkdf2Sync(password, entry.subarray(0, 16), 1000, 66, 'sha1');
      if (!keys.subarray(64, 66).equals(entry.subarray(16, 18))) throw new Error('wrong password');
      const body = entry.subarray(18, -10);
      expect(createHmac('sha1', keys.subarray(32, 64)).update(body).digest().subarray(0, 10).equals(entry.subarray(-10))).toBe(true);
      const plain = Buffer.alloc(body.length);
      for (let block = 0; block * 16 < body.length; block += 1) {
        const counter = Buffer.alloc(16);
        counter.writeUInt32LE(block + 1, 0);
        const cipher = createCipheriv('aes-256-ecb', keys.subarray(0, 32), null);
        const stream = cipher.update(counter);
        for (let j = 0; j < 16 && block * 16 + j < body.length; j += 1) plain[block * 16 + j] = body[block * 16 + j]! ^ stream[j]!;
      }
      files[name] = inflateRawSync(plain);
      at += 46 + nameLength + extraLength;
    }
    return files;
  }

  const encryptedExport = (client: Client, body: unknown) =>
    harness.handle(
      new Request(`${ORIGIN}/api/v1/exports`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: client.cookie, 'x-forwarded-for': client.ip, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('without the password nothing can be read; with it the content is complete and intact', async () => {
    const { client, expense } = await setUp();
    await expense(4560, 'very private text');
    const response = await encryptedExport(client, { password: PASSWORD_FOR_FILE });
    expect(response.status).toBe(200);
    const zip = Buffer.from(await response.arrayBuffer());
    expect(zip.includes('very private text')).toBe(false);
    expect(() => decrypt(zip, 'the wrong password here')).toThrow('wrong password');
    const files = decrypt(zip, PASSWORD_FOR_FILE);
    expect(Object.keys(files).sort()).toEqual(['accounts.csv', 'budgets.csv', 'categories.csv', 'data.json', 'goals.csv', 'payees.csv', 'planned.csv', 'reconciliations.csv', 'transactions.csv']);
    expect(files['transactions.csv']!.toString('utf8')).toContain('very private text');
  });

  test('two exports with the same password use different keys; the file holds no checksum of the content', async () => {
    const { client } = await setUp();
    const first = Buffer.from(await (await encryptedExport(client, { password: PASSWORD_FOR_FILE })).arrayBuffer());
    const second = Buffer.from(await (await encryptedExport(client, { password: PASSWORD_FOR_FILE })).arrayBuffer());
    const salt = (zip: Buffer) => {
      const nameLength = zip.readUInt16LE(26);
      return zip.subarray(30 + nameLength + zip.readUInt16LE(28), 46 + nameLength + zip.readUInt16LE(28)).toString('hex');
    };
    expect(salt(first)).not.toBe(salt(second));
    expect(first.readUInt32LE(14)).toBe(0);
  });

  test('a short password is refused, and the password is stored nowhere', async () => {
    const { client, email } = await setUp();
    expect((await encryptedExport(client, { password: 'short' })).status).toBe(422);
    expect((await encryptedExport(client, { password: PASSWORD_FOR_FILE })).status).toBe(200);
    const audit = await harness.database.pool.query(
      `SELECT e.* FROM fin.audit_events e WHERE e.event_type = 'export.created' AND e.user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email],
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain(PASSWORD_FOR_FILE);
    const idempotency = await harness.database.pool.query('SELECT 1 FROM fin.idempotency_records WHERE response::text LIKE $1', [`%${PASSWORD_FOR_FILE}%`]);
    expect(idempotency.rowCount).toBe(0);
  });
});

describe('opening balances (E-01)', () => {
  test("can't be voided or deleted on their own", async () => {
    const { client } = await setUp();
    const opening = (await client.call('GET', '/api/v1/transactions?from=2026-03-01&to=2026-03-01')).body.items[0];
    expect((await client.call('POST', `/api/v1/transactions/${opening.id}/void`, { key: key() })).body.code).toBe('NOT_EDITABLE');
    expect((await client.call('DELETE', `/api/v1/transactions/${opening.id}`, { headers: { 'if-match': '1' } })).body.code).toBe('NOT_EDITABLE');
  });
});
