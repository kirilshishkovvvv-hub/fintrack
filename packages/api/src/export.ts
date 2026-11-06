/**
 * "Export my data" (FR-17, PRV-03, Stage 2 §11.5): a ZIP of CSV files for spreadsheets plus one
 * JSON file as the complete machine-readable copy. Every status is included, labelled, so the
 * voided and deleted transactions a user can still see in the app are part of their copy.
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { formatAmount, Ledger, todayIn, type Chart, type LedgerAccount } from '@fintrack/domain';
import {
  currentConsents,
  getWorkspace,
  listReconciliations,
  listBudgetLimits,
  listGoals,
  listOccurrences,
  listPayees,
  listRules,
  loadAllocations,
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
export const numeric = (minor: number) => ({ numeric: formatAmount(minor) });

export type Cell = string | number | boolean | null | { numeric: string };

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

/**
 * AES-256 encryption of one ZIP entry, in the WinZip AE-2 format that 7-Zip and others read:
 * salt, password check, AES-CTR with a little-endian counter starting at 1, then 10 bytes of
 * HMAC-SHA1 over the ciphertext. The format fixes PBKDF2 at 1000 rounds, which is low, so the
 * API requires a long password.
 */
function encryptEntry(packed: Buffer, password: string): Buffer {
  const salt = randomBytes(16);
  const keys = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 66, 'sha1');
  const blocks = Math.ceil(packed.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let block = 0; block < blocks; block += 1) counters.writeBigUInt64LE(BigInt(block + 1), block * 16);
  const cipher = createCipheriv('aes-256-ecb', keys.subarray(0, 32), null);
  cipher.setAutoPadding(false);
  const stream = cipher.update(counters);
  const encrypted = Buffer.from(packed.map((byte, index) => byte ^ stream[index]!));
  const check = createHmac('sha1', keys.subarray(32, 64)).update(encrypted).digest().subarray(0, 10);
  return Buffer.concat([salt, keys.subarray(64, 66), encrypted, check]);
}

/** The extra field that marks an AE-2 entry: AES-256 over deflated data. */
const AES_EXTRA = Buffer.from([0x01, 0x99, 7, 0, 2, 0, 0x41, 0x45, 3, 8, 0]);

/**
 * A minimal ZIP writer: deflated entries, UTF-8 names, no ZIP64 (an export is far below 4 GB).
 * With a password every entry is AES-256 encrypted; the file names stay readable, as ZIP requires.
 */
export function toZip(files: readonly { name: string; data: Buffer }[], options: { at?: Date; password?: string | undefined } = {}): Buffer {
  const at = options.at ?? new Date();
  const { password } = options;
  const extra = password ? AES_EXTRA : Buffer.alloc(0);
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const deflated = deflateRawSync(file.data);
    const packed = password ? encryptEntry(deflated, password) : deflated;
    const shared = Buffer.alloc(26);
    shared.writeUInt16LE(password ? 51 : 20, 0); // version needed
    shared.writeUInt16LE(password ? 0x0801 : 0x0800, 2); // UTF-8 names, encrypted
    shared.writeUInt16LE(password ? 99 : 8, 4); // AES, or deflate
    shared.writeUInt16LE(time, 6);
    shared.writeUInt16LE(date, 8);
    // AE-2 leaves the checksum empty: it would reveal something about the content.
    shared.writeUInt32LE(password ? 0 : crc32(file.data), 10);
    shared.writeUInt32LE(packed.length, 14);
    shared.writeUInt32LE(file.data.length, 18);
    shared.writeUInt16LE(name.length, 22);
    shared.writeUInt16LE(extra.length, 24);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, name, extra, packed]);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    centrals.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02, password ? 51 : 20, 0]), shared, tail, name, extra]));
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
 * Builds the export package and records the audit event. Tags
 * join these files with the stages that bring them; the schema version covers that growth.
 */
export async function buildExport(db: Db, context: RequestContext, password?: string): Promise<{ filename: string; zip: Buffer }> {
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const locked = await lockedTransactionIds(db, context.workspaceId);
  const reconciliations = await listReconciliations(db, context.workspaceId);
  const consents = await currentConsents(db, context.userId);
  const payees = await listPayees(db, context.workspaceId);
  const rules = await listRules(db, context.workspaceId);
  const occurrences = await listOccurrences(db, context.workspaceId);
  const goals = await listGoals(db, context.workspaceId);
  const allocations = await loadAllocations(db, context.workspaceId);
  const budgets = await listBudgetLimits(db, context.workspaceId);
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
        ['transaction_id', 'date', 'kind', 'status', 'reconciled', 'description', 'memo', 'payee', 'refund_of', 'line', 'target_type', 'target', 'amount', 'currency', 'mark', 'line_note'],
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
              record.payeeName ?? null,
              record.tx.refundOfId ?? null,
              index + 1,
              targetType(target),
              target.name,
              numeric(posting.amount),
              currency,
              posting.mark ?? null,
              posting.memo ?? null,
            ];
          }),
        ),
      ),
    },
    {
      name: 'payees.csv',
      data: toCsv(
        ['id', 'name', 'default_category', 'archived'],
        payees.map((payee) => [payee.id, payee.name, payee.defaultCategoryId ? chart.get(payee.defaultCategoryId).name : null, payee.archived]),
      ),
    },
    {
      name: 'budgets.csv',
      data: toCsv(
        ['category', 'from_month', 'limit', 'currency'],
        budgets.map((row) => [row.categoryId ? chart.get(row.categoryId).name : 'Overall', row.effectiveMonth.slice(0, 7), row.limit === null ? null : formatAmount(row.limit), currency]),
      ),
    },
    {
      name: 'goals.csv',
      data: toCsv(
        ['id', 'name', 'funding', 'target', 'target_date', 'monthly', 'status'],
        goals.map((goal) => [goal.id, goal.name, goal.fundingMethod, goal.target === null ? null : formatAmount(goal.target), goal.targetDate, goal.monthly === null ? null : formatAmount(goal.monthly), goal.status]),
      ),
    },
    {
      name: 'planned.csv',
      data: toCsv(
        ['id', 'rule', 'kind', 'original_date', 'due_date', 'amount', 'status', 'transaction'],
        occurrences.map((occurrence) => {
          const rule = rules.find((candidate) => candidate.id === occurrence.ruleId)!;
          return [occurrence.id, rule.name, rule.kind, occurrence.originalDate, occurrence.dueDate, formatAmount(occurrence.amount), occurrence.status, occurrence.linkedTransactionId];
        }),
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
            payees,
            recurringRules: rules,
            plannedOccurrences: occurrences,
            goals,
            goalAllocations: allocations,
            budgetLimits: budgets,
            balances_minor: Object.fromEntries(accounts.map((account) => [account.id, ledger.balance(account.id, today)])),
            transactions: records.map((record) => ({
              ...record.tx,
              origin: record.origin,
              description: record.description,
              memo: record.memo,
              payee: record.payeeName ?? null,
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
  return { filename: `fintrack-export-${today}.zip`, zip: toZip(files, { password }) };
}
