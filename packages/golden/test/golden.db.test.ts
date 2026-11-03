/**
 * The same golden scenarios, stored in real PostgreSQL and read back (Stage 2 §12.2, level 2).
 * Proves that the database accepts every valid transaction under its constraints and
 * row-level security, and that what comes back yields exactly the same Stage 1 numbers.
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { Ledger, type LedgerAccount, type Transaction } from '@fintrack/domain';
import {
  changeTransactionStatus,
  createWorkspace,
  mergeCategory,
  replaceTransaction,
  setArchived,
  insertLedgerAccount,
  insertTransaction,
  loadChart,
  loadTransactions,
  uuidv7,
  withWorkspace,
} from '@fintrack/db';
import { startTestDatabase, type TestDatabase } from '../../db/src/test-database.ts';
import { runInMemory, scenarios, verifyCheck } from '@fintrack/golden';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe('golden scenarios (PostgreSQL round trip)', () => {
  for (const scenario of scenarios) {
    test(`${scenario.id} · ${scenario.title}`, async () => {
      const book = runInMemory(scenario);
      const context = { workspaceId: uuidv7(), userId: `user-${scenario.id}` };
      const ids = new Map<string, string>();

      await withWorkspace(
        database.pool,
        context,
        async (db) => {
          await createWorkspace(db, {
            id: context.workspaceId,
            name: scenario.id,
            currency: 'EUR',
            timezone: 'Europe/Sofia',
            ownerUserId: context.userId,
          });
          for (const system of (await loadChart(db, context.workspaceId)).all()) ids.set(`sys:${system.systemCode}`, system.id);

          const custom = book.chart.all().filter((account) => !account.systemCode);
          for (const account of custom) ids.set(account.id, uuidv7());
          // Parents before children, so the category foreign key is satisfied.
          custom.sort((a, b) => Number(a.category?.parentId !== undefined) - Number(b.category?.parentId !== undefined));
          for (const account of custom) {
            // Archiving is replayed from the book's history, at the point it happened.
            const { archived: _archived, ...active } = account;
            const mapped: LedgerAccount = { ...active, id: ids.get(account.id)! };
            if (account.category?.parentId) mapped.category = { parentId: ids.get(account.category.parentId)! };
            await insertLedgerAccount(db, context.workspaceId, mapped);
          }

          for (const tx of book.transactions) ids.set(tx.id, uuidv7());
          const map = (tx: Transaction): Transaction => {
            const mapped: Transaction = {
              ...tx,
              id: ids.get(tx.id)!,
              postings: tx.postings.map((posting) => ({ ...posting, ledgerAccountId: ids.get(posting.ledgerAccountId)! })),
            };
            if (tx.refundOfId) mapped.refundOfId = ids.get(tx.refundOfId)!;
            else delete mapped.refundOfId;
            return mapped;
          };
          // Replays the book's history through the store, so edits and lifecycle changes go
          // through the same database paths the application uses (LR-10, §9.3).
          const versions = new Map<string, number>();
          const next = (id: string) => versions.get(id)!;
          for (const event of book.events) {
            if (event.type === 'insert') {
              await insertTransaction(db, context.workspaceId, map(event.tx), { origin: 'manual', userId: context.userId });
              versions.set(event.tx.id, 1);
            } else if (event.type === 'replace') {
              const result = await replaceTransaction(db, context.workspaceId, map(event.tx), {
                expectedVersion: next(event.tx.id),
                userId: context.userId,
                description: null,
                memo: null,
              });
              versions.set(event.tx.id, result.version);
            } else if (event.type === 'archive') {
              await setArchived(db, context.workspaceId, ids.get(event.ledgerAccountId)!, true);
            } else if (event.type === 'merge') {
              await mergeCategory(db, context.workspaceId, ids.get(event.fromId)!, ids.get(event.intoId)!);
            } else {
              const type = event.status === 'posted' ? 'restore' : event.status === 'voided' ? 'void' : 'trash';
              const result = await changeTransactionStatus(db, context.workspaceId, ids.get(event.id)!, {
                to: event.status,
                type,
                expectedVersion: next(event.id),
                userId: context.userId,
              });
              versions.set(event.id, result.version);
            }
          }
        },
        { write: true },
      );

      const ledger = await withWorkspace(database.pool, context, async (db) => new Ledger(await loadChart(db, context.workspaceId), await loadTransactions(db, context.workspaceId)));
      const idOf = (name: string) => {
        const id = ids.get(name);
        if (!id) throw new Error(`No id for ${name}`);
        return id;
      };
      for (const check of scenario.checks) verifyCheck(ledger, check, idOf);
    });
  }
});
