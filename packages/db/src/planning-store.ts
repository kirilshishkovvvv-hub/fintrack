/**
 * Recurring rules, planned occurrences, budgets and goals (FR-07 to FR-09). Plain storage:
 * the rules live in the domain module and the API's services. Nothing here touches a posting.
 */
import {
  generationHorizon,
  matchingWindowDays,
  normalizeDescription,
  scheduledDates,
  type Allocation,
  type AmountType,
  type Frequency,
  type NonWorkingDay,
  type PlannedItem,
  type PlannedKind,
  type Schedule,
  type ScheduledDate,
} from '@fintrack/domain';
import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';

const iso = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleFrequency = Frequency | 'once';

export interface RuleLine {
  ledgerAccountId: string;
  amount: number;
}

export interface RuleFields {
  name: string;
  kind: PlannedKind;
  amountType: AmountType;
  accountId: string;
  frequency: RuleFrequency;
  interval: number;
  anchorDay: number | null;
  startDate: string;
  endDate: string | null;
  maxCount: number | null;
  nonWorkingDay: NonWorkingDay;
  isPayday: boolean;
  payerPayeeId: string | null;
  expectedMin: number | null;
  expectedMax: number | null;
  reminderDays: number;
  goalId: string | null;
}

export interface RuleRow extends RuleFields {
  id: string;
  status: 'active' | 'ended';
  generatedUntil: string | null;
  payerName: string | null;
  version: number;
  lines: RuleLine[];
}

const RULE_COLUMNS = `r.id, r.name, r.kind, r.amount_type, r.account_id, r.frequency, r.interval_n, r.anchor_day,
  ${iso('r.start_date')} AS start_date, ${iso('r.end_date')} AS end_date, r.max_count, r.non_working_day, r.is_payday,
  r.payer_payee_id, pa.name AS payer_name, r.expected_min_minor::text, r.expected_max_minor::text, r.reminder_days, r.goal_id, r.status,
  ${iso('r.generated_until')} AS generated_until, r.version`;

interface RawRule {
  id: string;
  name: string;
  kind: PlannedKind;
  amount_type: AmountType;
  account_id: string;
  frequency: RuleFrequency;
  interval_n: number;
  anchor_day: number | null;
  start_date: string;
  end_date: string | null;
  max_count: number | null;
  non_working_day: NonWorkingDay;
  is_payday: boolean;
  payer_payee_id: string | null;
  payer_name: string | null;
  expected_min_minor: string | null;
  expected_max_minor: string | null;
  reminder_days: number;
  goal_id: string | null;
  status: 'active' | 'ended';
  generated_until: string | null;
  version: number;
}

const toNumber = (value: string | null) => (value === null ? null : Number(value));

export async function listRules(db: Db, workspaceId: string): Promise<RuleRow[]> {
  const rules = await db.query<RawRule>(
    `SELECT ${RULE_COLUMNS} FROM fin.recurring_rules r
       LEFT JOIN fin.payees pa ON pa.id = r.payer_payee_id AND pa.workspace_id = r.workspace_id
      WHERE r.workspace_id = $1 ORDER BY r.name, r.id`,
    [workspaceId],
  );
  const lines = await db.query<{ rule_id: string; ledger_account_id: string; amount_minor: string }>(
    'SELECT rule_id, ledger_account_id, amount_minor::text FROM fin.recurring_rule_lines WHERE workspace_id = $1 ORDER BY rule_id, line_no',
    [workspaceId],
  );
  return rules.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    amountType: row.amount_type,
    accountId: row.account_id,
    frequency: row.frequency,
    interval: row.interval_n,
    anchorDay: row.anchor_day,
    startDate: row.start_date,
    endDate: row.end_date,
    maxCount: row.max_count,
    nonWorkingDay: row.non_working_day,
    isPayday: row.is_payday,
    payerPayeeId: row.payer_payee_id,
    payerName: row.payer_name,
    expectedMin: toNumber(row.expected_min_minor),
    expectedMax: toNumber(row.expected_max_minor),
    reminderDays: row.reminder_days,
    goalId: row.goal_id,
    status: row.status,
    generatedUntil: row.generated_until,
    version: row.version,
    lines: lines.rows.filter((line) => line.rule_id === row.id).map((line) => ({ ledgerAccountId: line.ledger_account_id, amount: Number(line.amount_minor) })),
  }));
}

async function writeLines(db: Db, workspaceId: string, ruleId: string, lines: readonly RuleLine[]): Promise<void> {
  await db.query('DELETE FROM fin.recurring_rule_lines WHERE workspace_id = $1 AND rule_id = $2', [workspaceId, ruleId]);
  for (const [index, line] of lines.entries()) {
    await db.query('INSERT INTO fin.recurring_rule_lines (rule_id, line_no, workspace_id, ledger_account_id, amount_minor) VALUES ($1, $2, $3, $4, $5)', [
      ruleId,
      index + 1,
      workspaceId,
      line.ledgerAccountId,
      line.amount,
    ]);
  }
}

export async function insertRule(db: Db, workspaceId: string, id: string, fields: RuleFields, lines: readonly RuleLine[]): Promise<void> {
  await db.query(
    `INSERT INTO fin.recurring_rules (id, workspace_id, name, kind, amount_type, account_id, frequency, interval_n, anchor_day, start_date, end_date,
                                      max_count, non_working_day, is_payday, payer_payee_id, expected_min_minor, expected_max_minor, reminder_days, goal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [id, workspaceId, fields.name, fields.kind, fields.amountType, fields.accountId, fields.frequency, fields.interval, fields.anchorDay, fields.startDate, fields.endDate, fields.maxCount, fields.nonWorkingDay, fields.isPayday, fields.payerPayeeId, fields.expectedMin, fields.expectedMax, fields.reminderDays, fields.goalId],
  );
  await writeLines(db, workspaceId, id, lines);
}

/** Returns false if the rule changed since it was read. */
export async function updateRule(db: Db, workspaceId: string, id: string, fields: RuleFields, lines: readonly RuleLine[], expectedVersion: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE fin.recurring_rules
        SET name = $3, kind = $4, amount_type = $5, account_id = $6, frequency = $7, interval_n = $8, anchor_day = $9, start_date = $10, end_date = $11,
            max_count = $12, non_working_day = $13, is_payday = $14, payer_payee_id = $15, expected_min_minor = $16, expected_max_minor = $17,
            reminder_days = $18, goal_id = $19, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $20`,
    [workspaceId, id, fields.name, fields.kind, fields.amountType, fields.accountId, fields.frequency, fields.interval, fields.anchorDay, fields.startDate, fields.endDate, fields.maxCount, fields.nonWorkingDay, fields.isPayday, fields.payerPayeeId, fields.expectedMin, fields.expectedMax, fields.reminderDays, fields.goalId, expectedVersion],
  );
  if (result.rowCount !== 1) return false;
  await writeLines(db, workspaceId, id, lines);
  return true;
}

export async function endRule(db: Db, workspaceId: string, id: string, endDate: string): Promise<void> {
  await db.query(`UPDATE fin.recurring_rules SET status = 'ended', end_date = GREATEST($3::date, start_date), version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2`, [workspaceId, id, endDate]);
  await db.query(`UPDATE fin.planned_occurrences SET status = 'cancelled', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND rule_id = $2 AND status = 'planned' AND due_date >= $3`, [workspaceId, id, endDate]);
}

export function scheduleOf(rule: Pick<RuleFields, 'frequency' | 'interval' | 'anchorDay' | 'startDate' | 'endDate' | 'maxCount' | 'nonWorkingDay'>): Schedule | null {
  if (rule.frequency === 'once') return null;
  return {
    frequency: rule.frequency,
    interval: rule.interval,
    ...(rule.anchorDay !== null ? { anchorDay: rule.anchorDay } : {}),
    startDate: rule.startDate,
    endDate: rule.endDate,
    maxCount: rule.maxCount,
    nonWorkingDay: rule.nonWorkingDay,
  };
}

/** A rule's dates up to `until`. A one-off has just its own date. */
export function datesOf(rule: RuleFields, until: string): ScheduledDate[] {
  const schedule = scheduleOf(rule);
  return schedule ? scheduledDates(schedule, until) : [{ originalDate: rule.startDate, dueDate: rule.startDate }];
}

const totalOf = (lines: readonly RuleLine[]) => lines.reduce((sum, line) => sum + line.amount, 0);

/**
 * Generates a rule's occurrences through the rolling window (BR-08.2). Safe to run any number
 * of times: the key (rule, original date) makes a repeat a no-op (AC-08.1).
 */
export async function generateOccurrences(db: Db, workspaceId: string, rule: RuleRow, today: string): Promise<void> {
  const until = generationHorizon(today);
  for (const date of datesOf(rule, until)) {
    await db.query(
      `INSERT INTO fin.planned_occurrences (id, workspace_id, rule_id, original_date, due_date, amount_minor, goal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (rule_id, original_date) DO NOTHING`,
      [uuidv7(), workspaceId, rule.id, date.originalDate, date.dueDate, totalOf(rule.lines), rule.goalId],
    );
  }
  await db.query('UPDATE fin.recurring_rules SET generated_until = $3 WHERE workspace_id = $1 AND id = $2', [workspaceId, rule.id, until]);
}

/**
 * Brings every active rule up to today's window. The worker that will do this daily doesn't
 * exist yet (AD-10), so the reads that need occurrences call it first.
 */
export async function ensureOccurrences(db: Db, workspaceId: string, today: string): Promise<void> {
  const until = generationHorizon(today);
  const due = await db.query<{ id: string }>(
    `SELECT id FROM fin.recurring_rules WHERE workspace_id = $1 AND status = 'active' AND (generated_until IS NULL OR generated_until < $2) LIMIT 1`,
    [workspaceId, until],
  );
  if (due.rows.length === 0) return;
  for (const rule of await listRules(db, workspaceId)) {
    if (rule.status === 'active' && (rule.generatedUntil === null || rule.generatedUntil < until)) await generateOccurrences(db, workspaceId, rule, today);
  }
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

export type OccurrenceStatus = 'planned' | 'completed' | 'skipped' | 'cancelled';

export interface OccurrenceRow {
  id: string;
  ruleId: string;
  originalDate: string;
  dueDate: string;
  amount: number;
  status: OccurrenceStatus;
  linkedTransactionId: string | null;
  goalId: string | null;
  isEdited: boolean;
  version: number;
}

const OCCURRENCE_COLUMNS = `o.id, o.rule_id, ${iso('o.original_date')} AS original_date, ${iso('o.due_date')} AS due_date, o.amount_minor::text, o.status,
  o.linked_transaction_id, o.goal_id, o.is_edited, o.version`;

interface RawOccurrence {
  id: string;
  rule_id: string;
  original_date: string;
  due_date: string;
  amount_minor: string;
  status: OccurrenceStatus;
  linked_transaction_id: string | null;
  goal_id: string | null;
  is_edited: boolean;
  version: number;
}

const toOccurrence = (row: RawOccurrence): OccurrenceRow => ({
  id: row.id,
  ruleId: row.rule_id,
  originalDate: row.original_date,
  dueDate: row.due_date,
  amount: Number(row.amount_minor),
  status: row.status,
  linkedTransactionId: row.linked_transaction_id,
  goalId: row.goal_id,
  isEdited: row.is_edited,
  version: row.version,
});

export async function listOccurrences(db: Db, workspaceId: string, ruleId?: string): Promise<OccurrenceRow[]> {
  const result = await db.query<RawOccurrence>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM fin.planned_occurrences o
      WHERE o.workspace_id = $1 AND ($2::uuid IS NULL OR o.rule_id = $2) ORDER BY o.due_date, o.original_date, o.id`,
    [workspaceId, ruleId ?? null],
  );
  return result.rows.map(toOccurrence);
}

export async function getOccurrence(db: Db, workspaceId: string, id: string): Promise<OccurrenceRow | null> {
  const result = await db.query<RawOccurrence>(`SELECT ${OCCURRENCE_COLUMNS} FROM fin.planned_occurrences o WHERE o.workspace_id = $1 AND o.id = $2`, [workspaceId, id]);
  return result.rows[0] ? toOccurrence(result.rows[0]) : null;
}

/** Every Planned occurrence, as Safe to Spend, budgets and matching read it. */
export async function loadPlannedItems(db: Db, workspaceId: string): Promise<PlannedItem[]> {
  const rules = new Map((await listRules(db, workspaceId)).map((rule) => [rule.id, rule]));
  const occurrences = (await listOccurrences(db, workspaceId)).filter((occurrence) => occurrence.status === 'planned');
  return occurrences.map((occurrence) => plannedItem(occurrence, rules.get(occurrence.ruleId)!));
}

export function plannedItem(occurrence: OccurrenceRow, rule: RuleRow): PlannedItem {
  const outgoing = rule.kind !== 'income';
  const counterpart = rule.kind === 'transfer' || rule.kind === 'debt_payment' ? rule.lines[0]?.ledgerAccountId ?? null : null;
  const categoryLines = rule.kind === 'transfer' ? [] : rule.kind === 'debt_payment' ? rule.lines.slice(1) : rule.lines;
  // An occurrence's own amount replaces a single line; a split keeps the rule's shares.
  const single = categoryLines.length === 1 && rule.kind !== 'debt_payment';
  const schedule = scheduleOf(rule);
  return {
    id: occurrence.id,
    name: rule.name,
    kind: rule.kind,
    originalDate: occurrence.originalDate,
    dueDate: occurrence.dueDate,
    amount: occurrence.amount,
    fromAccountId: outgoing ? rule.accountId : null,
    toAccountId: outgoing ? counterpart : rule.accountId,
    lines: categoryLines.map((line) => ({ categoryId: line.ledgerAccountId, amount: single ? occurrence.amount : line.amount })),
    isPayday: rule.isPayday,
    goalId: occurrence.goalId,
    amountType: rule.amountType,
    windowDays: matchingWindowDays(schedule),
    payer: rule.payerName ? normalizeDescription(rule.payerName) : null,
    expectedMin: rule.expectedMin,
    expectedMax: rule.expectedMax,
  };
}

export async function updateOccurrence(
  db: Db,
  workspaceId: string,
  id: string,
  change: { amount?: number | undefined; dueDate?: string | undefined; goalId?: string | null | undefined; expectedVersion: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE fin.planned_occurrences
        SET amount_minor = COALESCE($3, amount_minor), due_date = COALESCE($4, due_date),
            goal_id = CASE WHEN $5 THEN $6::uuid ELSE goal_id END,
            is_edited = true, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $7 AND status = 'planned'`,
    [workspaceId, id, change.amount ?? null, change.dueDate ?? null, change.goalId !== undefined, change.goalId ?? null, change.expectedVersion],
  );
  return result.rowCount === 1;
}

/** A rule edit: only for occurrences the caller found still planned and unedited (BR-08.6). */
export async function applyRuleToOccurrence(db: Db, workspaceId: string, id: string, values: { dueDate: string; amount: number; goalId: string | null }): Promise<void> {
  await db.query(
    `UPDATE fin.planned_occurrences SET due_date = $3, amount_minor = $4, goal_id = $5, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'planned' AND NOT is_edited`,
    [workspaceId, id, values.dueDate, values.amount, values.goalId],
  );
}

export async function cancelOccurrences(db: Db, workspaceId: string, ids: readonly string[]): Promise<void> {
  await db.query(`UPDATE fin.planned_occurrences SET status = 'cancelled', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status = 'planned'`, [workspaceId, ids]);
}

export async function insertOccurrence(db: Db, workspaceId: string, ruleId: string, date: ScheduledDate, amount: number, goalId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO fin.planned_occurrences (id, workspace_id, rule_id, original_date, due_date, amount_minor, goal_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (rule_id, original_date) DO NOTHING`,
    [uuidv7(), workspaceId, ruleId, date.originalDate, date.dueDate, amount, goalId],
  );
}

/** Import rows accepted as a planned item (GT-37), per batch. */
export async function rowOccurrences(db: Db, workspaceId: string, batchId: string): Promise<Map<string, string>> {
  const result = await db.query<{ id: string; planned_occurrence_id: string }>('SELECT id, planned_occurrence_id FROM fin.import_rows WHERE workspace_id = $1 AND batch_id = $2 AND planned_occurrence_id IS NOT NULL', [workspaceId, batchId]);
  return new Map(result.rows.map((row) => [row.id, row.planned_occurrence_id]));
}

export async function setRowOccurrence(db: Db, workspaceId: string, rowId: string, occurrenceId: string | null): Promise<void> {
  await db.query('UPDATE fin.import_rows SET planned_occurrence_id = $3 WHERE workspace_id = $1 AND id = $2', [workspaceId, rowId, occurrenceId]);
}

/** BR-08.4: fails on a second link, in either direction. The unique column backs this up. */
export async function completeOccurrence(db: Db, workspaceId: string, id: string, transactionId: string): Promise<boolean> {
  const taken = await db.query('SELECT 1 FROM fin.planned_occurrences WHERE workspace_id = $1 AND linked_transaction_id = $2', [workspaceId, transactionId]);
  if ((taken.rowCount ?? 0) > 0) return false;
  const result = await db.query(
    `UPDATE fin.planned_occurrences SET status = 'completed', linked_transaction_id = $3, previous_transaction_id = NULLIF(previous_transaction_id, $3), version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'planned'`,
    [workspaceId, id, transactionId],
  );
  return result.rowCount === 1;
}

export async function setOccurrenceStatus(db: Db, workspaceId: string, id: string, from: OccurrenceStatus, to: OccurrenceStatus): Promise<boolean> {
  const result = await db.query(
    `UPDATE fin.planned_occurrences SET status = $4, linked_transaction_id = NULL, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = $3`,
    [workspaceId, id, from, to],
  );
  return result.rowCount === 1;
}

/** Void or trash: the occurrence goes back to Planned, remembering the transaction (GAP-1, GT-44). */
export async function reopenLinkedOccurrence(db: Db, workspaceId: string, transactionId: string): Promise<void> {
  await db.query(
    `UPDATE fin.planned_occurrences
        SET status = 'planned', linked_transaction_id = NULL, previous_transaction_id = $2, version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND linked_transaction_id = $2`,
    [workspaceId, transactionId],
  );
}

/** Restore: linked again, unless another transaction took the occurrence meanwhile (GT-44). Returns false if it did. */
export async function relinkOccurrence(db: Db, workspaceId: string, transactionId: string): Promise<boolean> {
  const waiting = await db.query<{ id: string; status: OccurrenceStatus }>('SELECT id, status FROM fin.planned_occurrences WHERE workspace_id = $1 AND previous_transaction_id = $2', [workspaceId, transactionId]);
  const row = waiting.rows[0];
  if (!row) return true;
  if (row.status !== 'planned') return false;
  return completeOccurrence(db, workspaceId, row.id, transactionId);
}

/** The planned item a transaction paid, for its detail screen. */
export async function occurrenceOfTransaction(db: Db, workspaceId: string, transactionId: string): Promise<{ id: string; name: string; dueDate: string } | null> {
  const result = await db.query<{ id: string; name: string; due_date: string }>(
    `SELECT o.id, r.name, ${iso('o.due_date')} AS due_date FROM fin.planned_occurrences o
       JOIN fin.recurring_rules r ON r.id = o.rule_id
      WHERE o.workspace_id = $1 AND o.linked_transaction_id = $2`,
    [workspaceId, transactionId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, dueDate: row.due_date } : null;
}

/** BR-07.13: marks a purchase as bought on an instalment plan. It changes no figure. */
export async function setInstalment(db: Db, workspaceId: string, transactionId: string, value: boolean): Promise<void> {
  await db.query('UPDATE fin.transactions SET is_instalment = $3 WHERE workspace_id = $1 AND id = $2', [workspaceId, transactionId, value]);
}

/** The instalment purchases of a month, by category line. */
export async function instalmentLines(db: Db, workspaceId: string, month: string): Promise<{ categoryId: string; description: string | null; amount: number }[]> {
  const result = await db.query<{ ledger_account_id: string; description: string | null; amount_minor: string }>(
    `SELECT p.ledger_account_id, t.description, p.amount_minor::text
       FROM fin.postings p JOIN fin.transactions t ON t.id = p.transaction_id
      WHERE p.workspace_id = $1 AND t.workspace_id = $1 AND t.is_instalment AND t.status = 'posted' AND p.amount_minor > 0
        AND t.txn_date >= $2::date AND t.txn_date < $2::date + interval '1 month'`,
    [workspaceId, month],
  );
  return result.rows.map((row) => ({ categoryId: row.ledger_account_id, description: row.description, amount: Number(row.amount_minor) }));
}

export async function linkedTransactionIds(db: Db, workspaceId: string): Promise<Set<string>> {
  const result = await db.query<{ linked_transaction_id: string }>('SELECT linked_transaction_id FROM fin.planned_occurrences WHERE workspace_id = $1 AND linked_transaction_id IS NOT NULL', [workspaceId]);
  return new Set(result.rows.map((row) => row.linked_transaction_id));
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: string;
  name: string;
  fundingMethod: 'dedicated' | 'virtual';
  target: number | null;
  targetDate: string | null;
  monthly: number | null;
  status: 'active' | 'archived';
  /** Creation order, for the tie-break in backed amounts (§8.1). */
  order: number;
  used: number;
  version: number;
}

export async function listGoals(db: Db, workspaceId: string): Promise<GoalRow[]> {
  const result = await db.query<{ id: string; name: string; funding_method: 'dedicated' | 'virtual'; target_minor: string | null; target_date: string | null; monthly_contribution_minor: string | null; status: 'active' | 'archived'; used: string; version: number }>(
    `SELECT g.id, g.name, g.funding_method, g.target_minor::text, ${iso('g.target_date')} AS target_date, g.monthly_contribution_minor::text, g.status, g.version,
            COALESCE((SELECT -SUM(e.delta_minor) FROM fin.allocation_events e WHERE e.workspace_id = g.workspace_id AND e.goal_id = g.id AND e.event = 'use_goal_money'), 0)::text AS used
       FROM fin.goals g WHERE g.workspace_id = $1 ORDER BY g.created_at, g.id`,
    [workspaceId],
  );
  return result.rows.map((row, index) => ({
    id: row.id,
    name: row.name,
    fundingMethod: row.funding_method,
    target: toNumber(row.target_minor),
    targetDate: row.target_date,
    monthly: toNumber(row.monthly_contribution_minor),
    status: row.status,
    order: index,
    used: Number(row.used),
    version: row.version,
  }));
}

export async function insertGoal(db: Db, workspaceId: string, id: string, goal: { name: string; fundingMethod: 'dedicated' | 'virtual'; target: number | null; targetDate: string | null; monthly: number | null }): Promise<void> {
  await db.query('INSERT INTO fin.goals (id, workspace_id, name, funding_method, target_minor, target_date, monthly_contribution_minor) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, workspaceId, goal.name, goal.fundingMethod, goal.target, goal.targetDate, goal.monthly]);
}

export async function updateGoal(db: Db, workspaceId: string, id: string, goal: { name: string; target: number | null; targetDate: string | null; monthly: number | null; status?: 'active' | 'archived' }, expectedVersion: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE fin.goals SET name = $3, target_minor = $4, target_date = $5, monthly_contribution_minor = $6, status = COALESCE($7, status), version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $8`,
    [workspaceId, id, goal.name, goal.target, goal.targetDate, goal.monthly, goal.status ?? null, expectedVersion],
  );
  return result.rowCount === 1;
}

export async function setGoalFunding(db: Db, workspaceId: string, id: string, fundingMethod: 'dedicated' | 'virtual'): Promise<void> {
  await db.query('UPDATE fin.goals SET funding_method = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, id, fundingMethod]);
}

/** Every allocation above 0, with its goal's creation order (§8.1). */
export async function loadAllocations(db: Db, workspaceId: string): Promise<Allocation[]> {
  const goals = await listGoals(db, workspaceId);
  const result = await db.query<{ goal_id: string; account_id: string; amount_minor: string }>('SELECT goal_id, account_id, amount_minor::text FROM fin.goal_allocations WHERE workspace_id = $1 AND amount_minor > 0', [workspaceId]);
  const order = new Map(goals.map((goal) => [goal.id, goal.order]));
  return result.rows.map((row) => ({ goalId: row.goal_id, accountId: row.account_id, amount: Number(row.amount_minor), goalOrder: order.get(row.goal_id) ?? 0 }));
}

/** Changes one allocation by `delta` and writes its history line, in one step (G-V6). */
export async function changeAllocation(
  db: Db,
  workspaceId: string,
  change: { goalId: string; accountId: string; delta: number; event: 'create' | 'increase' | 'decrease' | 'release' | 'move' | 'use_goal_money'; userId: string; reason?: string | null; transactionId?: string | null },
): Promise<void> {
  // A proposed row must pass its checks before ON CONFLICT applies, so a decrease is an update.
  if (change.delta < 0) {
    await db.query('UPDATE fin.goal_allocations SET amount_minor = amount_minor + $4, updated_at = now() WHERE workspace_id = $1 AND goal_id = $2 AND account_id = $3', [workspaceId, change.goalId, change.accountId, change.delta]);
  } else {
    await db.query(
      `INSERT INTO fin.goal_allocations (goal_id, account_id, workspace_id, amount_minor) VALUES ($1, $2, $3, $4)
       ON CONFLICT (goal_id, account_id) DO UPDATE SET amount_minor = fin.goal_allocations.amount_minor + EXCLUDED.amount_minor, updated_at = now()`,
      [change.goalId, change.accountId, workspaceId, change.delta],
    );
  }
  await db.query(
    `INSERT INTO fin.allocation_events (id, workspace_id, goal_id, account_id, event, delta_minor, reason, transaction_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuidv7(), workspaceId, change.goalId, change.accountId, change.event, change.delta, change.reason ?? null, change.transactionId ?? null, change.userId],
  );
}

export async function allocationHistory(db: Db, workspaceId: string, goalId: string) {
  const result = await db.query<{ account_id: string; event: string; delta_minor: string; reason: string | null; transaction_id: string | null; occurred_at: Date }>(
    'SELECT account_id, event, delta_minor::text, reason, transaction_id, occurred_at FROM fin.allocation_events WHERE workspace_id = $1 AND goal_id = $2 ORDER BY occurred_at DESC, id DESC',
    [workspaceId, goalId],
  );
  return result.rows.map((row) => ({ accountId: row.account_id, event: row.event, delta: Number(row.delta_minor), reason: row.reason, transactionId: row.transaction_id, occurredAt: row.occurred_at.toISOString() }));
}

/** Links an account to a goal (non-spendable, G-D3), or unlinks it (the user's chosen setting, G-D6). */
export async function setDedicatedGoal(db: Db, workspaceId: string, accountId: string, goalId: string | null, spendable: boolean): Promise<void> {
  await db.query('UPDATE fin.accounts SET dedicated_goal_id = $3, spendable = $4 WHERE workspace_id = $1 AND ledger_account_id = $2', [workspaceId, accountId, goalId, spendable]);
}

export async function dedicatedAccounts(db: Db, workspaceId: string): Promise<Map<string, string[]>> {
  const result = await db.query<{ ledger_account_id: string; dedicated_goal_id: string }>('SELECT ledger_account_id, dedicated_goal_id FROM fin.accounts WHERE workspace_id = $1 AND dedicated_goal_id IS NOT NULL ORDER BY ledger_account_id', [workspaceId]);
  const byGoal = new Map<string, string[]>();
  for (const row of result.rows) byGoal.set(row.dedicated_goal_id, [...(byGoal.get(row.dedicated_goal_id) ?? []), row.ledger_account_id]);
  return byGoal;
}

export async function setRuleGoal(db: Db, workspaceId: string, ruleId: string, goalId: string | null): Promise<void> {
  await db.query('UPDATE fin.recurring_rules SET goal_id = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, ruleId, goalId]);
  await db.query(`UPDATE fin.planned_occurrences SET goal_id = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND rule_id = $2 AND status = 'planned'`, [workspaceId, ruleId, goalId]);
}

export async function setOccurrenceGoal(db: Db, workspaceId: string, id: string, goalId: string | null): Promise<boolean> {
  const result = await db.query(`UPDATE fin.planned_occurrences SET goal_id = $3, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'planned'`, [workspaceId, id, goalId]);
  return result.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface BudgetLimitRow {
  categoryId: string | null;
  effectiveMonth: string;
  limit: number | null;
  thresholds: number[];
}

export async function listBudgetLimits(db: Db, workspaceId: string): Promise<BudgetLimitRow[]> {
  const result = await db.query<{ category_id: string | null; effective_month: string; limit_minor: string | null; thresholds: number[] }>(
    `SELECT category_id, ${iso('effective_month')} AS effective_month, limit_minor::text, thresholds FROM fin.budget_limits WHERE workspace_id = $1 ORDER BY effective_month`,
    [workspaceId],
  );
  return result.rows.map((row) => ({ categoryId: row.category_id, effectiveMonth: row.effective_month, limit: toNumber(row.limit_minor), thresholds: row.thresholds }));
}

/** Sets the row for one month. `clearLater` removes later rows, so the change carries forward (BR-07.1). */
export async function setBudgetLimit(db: Db, workspaceId: string, categoryId: string | null, effectiveMonth: string, limit: number | null, thresholds: readonly number[], clearLater: boolean): Promise<void> {
  if (clearLater) await db.query('DELETE FROM fin.budget_limits WHERE workspace_id = $1 AND category_id IS NOT DISTINCT FROM $2 AND effective_month > $3', [workspaceId, categoryId, effectiveMonth]);
  const updated = await db.query('UPDATE fin.budget_limits SET limit_minor = $4, thresholds = $5 WHERE workspace_id = $1 AND category_id IS NOT DISTINCT FROM $2 AND effective_month = $3', [workspaceId, categoryId, effectiveMonth, limit, thresholds]);
  if (updated.rowCount === 1) return;
  await db.query('INSERT INTO fin.budget_limits (id, workspace_id, category_id, effective_month, limit_minor, thresholds) VALUES ($1, $2, $3, $4, $5, $6)', [uuidv7(), workspaceId, categoryId, effectiveMonth, limit, thresholds]);
}

/** Returns true the one time a threshold fires for a budget and month (AC-07.2). */
export async function fireBudgetAlert(db: Db, workspaceId: string, categoryId: string, month: string, threshold: number): Promise<boolean> {
  const result = await db.query('INSERT INTO fin.budget_alert_events (workspace_id, category_id, month, threshold) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [workspaceId, categoryId, month, threshold]);
  return result.rowCount === 1;
}

export async function listBudgetAlerts(db: Db, workspaceId: string, month: string): Promise<{ categoryId: string; threshold: number }[]> {
  const result = await db.query<{ category_id: string; threshold: number }>('SELECT category_id, threshold FROM fin.budget_alert_events WHERE workspace_id = $1 AND month = $2', [workspaceId, month]);
  return result.rows.map((row) => ({ categoryId: row.category_id, threshold: row.threshold }));
}
