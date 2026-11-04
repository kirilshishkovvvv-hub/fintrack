/** Every kind of entry and its edit through the API (FR-04, FR-06, BR-04.7, BR-06.1, BR-06.4, E-39). */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { key, startHarness, verifiedUser, type Harness } from './harness.ts';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

let counter = 0;

async function setUp() {
  const client = await verifiedUser(harness, `entry-${++counter}@example.com`);
  await client.call('POST', '/api/v1/workspaces', { body: { name: 'P', currency: 'EUR', timezone: 'Europe/Sofia' } });
  const categories = (await client.call('GET', '/api/v1/categories')).body.items as { id: string; name: string }[];
  const category = (name: string) => categories.find((c) => c.name === name)!.id;
  const account = async (name: string, type: string, opening = 0) =>
    (await client.call('POST', '/api/v1/accounts', { key: key(), body: { name, type, openingDate: '2026-03-01', openingAmount_minor: opening } })).body.id as string;
  const post = (body: unknown) => client.call('POST', '/api/v1/transactions', { key: key(), body });
  const balances = async () => Object.fromEntries(((await client.call('GET', '/api/v1/accounts')).body.items as any[]).map((a) => [a.name, a.balance_minor]));
  return { client, category, account, post, balances };
}

describe('refunds (FR-04)', () => {
  test('AC-04.3: a refund linked to an expense reduces it; one above the original needs explicit confirmation (BR-04.7)', async () => {
    const { category, account, post, balances } = await setUp();
    const current = await account('Current', 'current', 100000);
    const expense = (await post({ kind: 'expense', date: '2026-03-05', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 10000 }] })).body;
    const refund = { kind: 'refund', date: '2026-03-08', accountId: current, refundOfId: expense.id, lines: [{ categoryId: category('Food'), amount_minor: 3000 }] };
    expect((await post(refund)).status).toBe(201);
    expect((await balances()).Current).toBe(93000);

    const tooBig = { ...refund, lines: [{ categoryId: category('Food'), amount_minor: 10001 }] };
    const refused = await post(tooBig);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'REFUND_EXCEEDS_ORIGINAL', details: { refund_minor: 10001, original_minor: 10000 } });
    expect((await balances()).Current).toBe(93000);
    expect((await post({ ...tooBig, confirmExceedsOriginal: true })).status).toBe(201);
  });

  test('E-39: when the original is deleted, the refund stays and says so', async () => {
    const { client, category, account, post, balances } = await setUp();
    const current = await account('Current', 'current', 100000);
    const expense = (await post({ kind: 'expense', date: '2026-03-05', accountId: current, lines: [{ categoryId: category('Food'), amount_minor: 10000 }] })).body;
    const refund = (await post({ kind: 'refund', date: '2026-03-08', accountId: current, refundOfId: expense.id, lines: [{ categoryId: category('Food'), amount_minor: 3000 }] })).body;
    expect((await client.call('GET', `/api/v1/transactions/${refund.id}`)).body.refundOriginalStatus).toBe('posted');
    await client.call('DELETE', `/api/v1/transactions/${expense.id}`, { headers: { 'if-match': '1' } });
    expect((await client.call('GET', `/api/v1/transactions/${refund.id}`)).body.refundOriginalStatus).toBe('trashed');
    expect((await balances()).Current).toBe(103000);
  });
});

describe('splits (FR-06)', () => {
  test('line notes are stored, returned, and survive an edit (BR-06.4); a discount line and a deduction line count properly', async () => {
    const { client, category, account, post, balances } = await setUp();
    const current = await account('Current', 'current', 100000);
    const split = {
      kind: 'expense',
      date: '2026-03-05',
      accountId: current,
      lines: [
        { categoryId: category('Food'), amount_minor: 6000, memo: 'for the party' },
        { categoryId: category('Household'), amount_minor: 2000 },
        { categoryId: category('Food'), amount_minor: 500, mark: 'discount', memo: 'coupon' },
      ],
    };
    const created = await post(split);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await balances()).Current).toBe(92500);
    const detail = (await client.call('GET', `/api/v1/transactions/${created.body.id}`)).body;
    expect(detail.lines.map((line: any) => line.memo).filter(Boolean)).toEqual(['for the party', 'coupon']);
    const edited = await client.call('PATCH', `/api/v1/transactions/${created.body.id}`, { headers: { 'if-match': '1' }, body: { ...split, lines: [{ categoryId: category('Food'), amount_minor: 6500, memo: 'changed' }] } });
    expect(edited.status).toBe(200);
    expect(edited.body.lines.map((line: any) => line.memo).filter(Boolean)).toEqual(['changed']);

    const salary = await post({
      kind: 'income',
      date: '2026-03-10',
      accountId: current,
      lines: [{ categoryId: category('Salary'), amount_minor: 200000 }, { categoryId: category('Taxes'), amount_minor: 30000, mark: 'deduction' }],
    });
    expect(salary.status, JSON.stringify(salary.body)).toBe(201);
    expect((await balances()).Current).toBe(93500 + 170000);
  });

  test('BR-06.1: part of a payment can go to an account; lines that do not balance are refused (AC-06.1)', async () => {
    const { client, category, account, post, balances } = await setUp();
    const current = await account('Current', 'current', 100000);
    const savings = await account('Savings', 'savings');
    const split = { kind: 'split', date: '2026-03-05', lines: [{ ledgerAccountId: current, amount_minor: -5000 }, { ledgerAccountId: category('Food'), amount_minor: 3000 }, { ledgerAccountId: savings, amount_minor: 2000 }] };
    expect((await post(split)).status).toBe(201);
    expect(await balances()).toMatchObject({ Current: 95000, Savings: 2000 });
    const off = await post({ ...split, lines: [{ ledgerAccountId: current, amount_minor: -5000 }, { ledgerAccountId: category('Food'), amount_minor: 4999 }] });
    expect(off.status).toBe(422);
    expect(off.body.code).toBe('LEDGER_RULE');
    expect((await client.call('GET', '/api/v1/summary?at=2026-03-31')).body.netWorth_minor).toBe(97000);
  });
});

describe('debt payments (E-27)', () => {
  test('principal lowers the debt; interest and a fee are expenses; an edit applies only the difference', async () => {
    const { client, category, account, post, balances } = await setUp();
    const current = await account('Current', 'current', 100000);
    const loan = await account('Loan', 'loan', 500000);
    const body = { kind: 'debt_payment', date: '2026-03-05', fromAccountId: current, liabilityAccountId: loan, principal_minor: 20000, extras: [{ categoryId: category('Interest and fees'), amount_minor: 1500 }, { categoryId: category('Bank fees'), amount_minor: 100 }] };
    const created = await post(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await balances()).toMatchObject({ Current: 78400, Loan: 480000 });
    const edited = await client.call('PATCH', `/api/v1/transactions/${created.body.id}`, { headers: { 'if-match': '1' }, body: { ...body, principal_minor: 25000 } });
    expect(edited.status).toBe(200);
    expect(await balances()).toMatchObject({ Current: 73400, Loan: 475000 });
  });
});
