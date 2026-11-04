/**
 * "Export my data" (FR-17, PRV-03, Stage 2 §11.5): a ZIP of CSV files for spreadsheets plus one
 * JSON file as the complete machine-readable copy. Every status is included, labelled, so the
 * voided and deleted transactions a user can still see in the app are part of their copy.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { formatAmount, Ledger, todayIn, type Chart, type LedgerAccount } from '@fintrack/domain';
import {
  currentConsents,
  getWorkspace,
  listReconciliations,
  listTransactionVersions,
  loadChart,
  loadTransactionRecords,
  lockedTransactionIds,
  recordAuditEvent,
  type Db,
  type RequestContext,
} from '@fintrack/db';

export const EXPORT_SCHEMA_VERSION = 1;

/** A text cell that a spreadsheet could run as a formula is made inert with a leading apostrophe (AC-17.3). */
export function inertText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Marks a cell from a numeric-only column, which FR-17 exempts from escaping: "-8.00" must stay a number. */
const numeric = (minor: number) => ({ numeric: formatAmount(minor) });

type Cell = string | number | boolean | null | { numeric: string };

function cellText(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'object') return cell.numeric;
  if (typeof cell === 'string') return inertText(cell);
  return String(cell);
}

/** RFC 4180 CSV, UTF-8 with a BOM so that Excel reads every language correctly (FR-17). */
export function toCsv(header: readonly string[], rows: readonly Cell[][]): Buffer {
  const line = (cells: readonly string[]) => cells.map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(',');
  const body = [line(header), ...rows.map((row) => line(row.map(cellText)))].join('\r\n');
  return Buffer.from(`﻿${body}\r\n`, 'utf8');
}

/** A minimal ZIP writer: deflated entries, UTF-8 names, no ZIP64 (an export is far below 4 GB). */
export function toZip(files: readonly { name: string; data: Buffer }[], at = new Date()): Buffer {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const packed = deflateRawSync(file.data);
    const shared = Buffer.alloc(26);
    shared.writeUInt16LE(20, 0); // version needed
    shared.writeUInt16LE(0x0800, 2); // UTF-8 names
    shared.writeUInt16LE(8, 4); // deflate
    shared.writeUInt16LE(time, 6);
    shared.writeUInt16LE(date, 8);
    shared.writeUInt32LE(crc32(file.data), 10);
    shared.writeUInt32LE(packed.length, 14);
    shared.writeUInt32LE(file.data.length, 18);
    shared.writeUInt16LE(name.length, 22);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, name, packed]);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    centrals.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), shared, tail, name]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function targetType(account: LedgerAccount): string {
  if (account.account) return 'account';
  if (account.category) return 'category';
  return 'system';
}

function parentName(chart: Chart, account: LedgerAccount): string | null {
  return account.category?.parentId ? chart.get(account.category.parentId).name : null;
}

/**
 * Builds the export package and records the audit event. Budgets, goals, rules, payees and tags
 * join these files with the stages that bring them; the schema version covers that growth.
 */
export async function buildExport(db: Db, context: RequestContext): Promise<{ filename: string; zip: Buffer }> {
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const locked = await lockedTransactionIds(db, context.workspaceId);
  const reconciliations = await listReconciliations(db, context.workspaceId);
  const consents = await currentConsents(db, context.userId);
  const ledger = new Ledger(chart, records.map((record) => record.tx));
  const today = todayIn(workspace.timezone);
  const { currency } = workspace;
  const accounts = chart.all().filter((account) => account.account);
  const categories = chart.all().filter((account) => account.category);

  const versions = [];
  for (const record of records) {
    const entries = await listTransactionVersions(db, context.workspaceId, record.tx.id);
    versions.push(...entries.map((entry) => ({ transactionId: record.tx.id, ...entry })));
  }

  const files = [
    {
      name: 'accounts.csv',
      data: toCsv(
        ['id', 'name', 'type', 'class', 'spendable', 'card_reserve', 'opening_date', 'archived', 'balance', 'currency'],
        accounts.map((account) => [
          account.id,
          account.name,
          account.account!.type,
          account.account!.class,
          account.account!.spendable,
          account.account!.cardReserve,
          account.account!.openingDate,
          account.archived ?? false,
          numeric(ledger.balance(account.id, today)),
          currency,
        ]),
      ),
    },
    {
      name: 'categories.csv',
      data: toCsv(
        ['id', 'name', 'kind', 'parent', 'archived'],
        categories.map((category) => [category.id, category.name, category.kind, parentName(chart, category), category.archived ?? false]),
      ),
    },
    {
      // One row per line. The lines of each transaction sum to 0 (AC-17.1).
      name: 'transactions.csv',
      data: toCsv(
        ['transaction_id', 'date', 'kind', 'status', 'reconciled', 'description', 'memo', 'refund_of', 'line', 'target_type', 'target', 'amount', 'currency', 'mark'],
        records.flatMap((record) =>
          record.tx.postings.map((posting, index): Cell[] => {
            const target = chart.get(posting.ledgerAccountId);
            return [
              record.tx.id,
              record.tx.date,
              record.tx.kind,
              record.tx.status,
              locked.has(record.tx.id),
              record.description,
              record.memo,
              record.tx.refundOfId ?? null,
              index + 1,
              targetType(target),
              target.name,
              numeric(posting.amount),
              currency,
              posting.mark ?? null,
            ];
          }),
        ),
      ),
    },
    {
      name: 'reconciliations.csv',
      data: toCsv(
        ['id', 'account', 'statement_date', 'statement_balance', 'currency', 'status', 'completed_at', 'unlocked_at', 'transaction_count'],
        reconciliations.map((row) => [
          row.id,
          chart.get(row.accountId).name,
          row.statementDate,
          numeric(row.statementBalance),
          currency,
          row.status,
          row.completedAt,
          row.unlockedAt,
          row.transactionIds.length,
        ]),
      ),
    },
    {
      name: 'data.json',
      data: Buffer.from(
        JSON.stringify(
          {
            schemaVersion: EXPORT_SCHEMA_VERSION,
            exportedOn: today,
            workspace: { name: workspace.name, currency, timezone: workspace.timezone, protectedReserve_minor: workspace.protectedReserveMinor },
            ledgerAccounts: chart.all(),
            balances_minor: Object.fromEntries(accounts.map((account) => [account.id, ledger.balance(account.id, today)])),
            transactions: records.map((record) => ({
              ...record.tx,
              origin: record.origin,
              description: record.description,
              memo: record.memo,
              version: record.version,
              trashedAt: record.trashedAt,
            })),
            transactionVersions: versions,
            reconciliations,
            consents,
          },
          null,
          2,
        ),
        'utf8',
      ),
    },
  ];
  await recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type: 'export.created', objectType: 'workspace', objectId: context.workspaceId });
  return { filename: `fintrack-export-${today}.zip`, zip: toZip(files) };
}
