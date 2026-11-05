/**
 * Recurring rules and planned occurrences (FR-08, FR-11). Occurrences are completed by
 * confirming, by linking an existing transaction, or skipped; matching only ever suggests (M-5).
 */
import { generationHorizon, Ledger, projection, regenerate, todayIn, type Chart, type Transaction } from '@fintrack/domain';
import {
  applyRuleToOccurrence,
  cancelOccurrences,
  completeOccurrence,
  datesOf,
  endRule,
  ensureOccurrences,
  ensurePayee,
  generateOccurrences,
  getOccurrence,
  getWorkspace,
  insertOccurrence,
  insertRule,
  listGoals,
  listOccurrences,
  listRules,
  loadChart,
  loadTransactionRecord,
  loadTransactionRecords,
  loadTransactions,
  plannedItem,
  recordAuditEvent,
  scheduleOf,
  setOccurrenceStatus,
  updateOccurrence,
  updateRule,
  uuidv7,
  type Db,
  type OccurrenceRow,
  type RequestContext,
  type RuleFields,
  type RuleLine,
  type RuleRow,
} from '@fintrack/db';
import type { z } from 'zod';
import { ApiError } from './http.ts';
import { releaseGoalMoney, safeToSpendFigures } from './plan-state.ts';
import type { confirmOccurrenceBody, createRuleBody, editOccurrenceBody, updateRuleBody } from './schemas.ts';
import { recordTransaction, recordTransfer } from './services.ts';

function event(db: Db, context: RequestContext, type: string, objectType: string, objectId: string) {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType, objectId });
}

async function today(db: Db, context: RequestContext) {
  return todayIn((await getWorkspace(db, context.workspaceId)).timezone);
}

const toLines = (lines: readonly { ledgerAccountId: string; amount_minor: number }[]): RuleLine[] => lines.map((line) => ({ ledgerAccountId: line.ledgerAccountId, amount: line.amount_minor }));
const totalOf = (lines: readonly RuleLine[]) => lines.reduce((sum, line) => sum + line.amount, 0);

/** The template must be a transaction the ledger could accept (§5.4), so confirming can't fail later on its shape. */
function checkTemplate(chart: Chart, kind: RuleFields['kind'], accountId: string, lines: readonly RuleLine[]): void {
  const account = chart.find(accountId);
  if (!account?.account || account.archived) throw new ApiError(422, 'INVALID_REFERENCE', 'The account does not exist');
  const invalid = (message: string) => new ApiError(422, 'VALIDATION_FAILED', message);
  const category = (id: string, wanted: 'income' | 'expense') => {
    const found = chart.find(id);
    if (!found?.category || found.archived) throw new ApiError(422, 'INVALID_REFERENCE', 'The category does not exist');
    if (found.kind !== wanted) throw invalid(`The category must be an ${wanted} category`);
  };
  if (kind === 'expense' || kind === 'income') {
    for (const line of lines) category(line.ledgerAccountId, kind);
    return;
  }
  const other = chart.find(lines[0]!.ledgerAccountId);
  if (!other?.account || other.archived || other.id === accountId) throw new ApiError(422, 'INVALID_REFERENCE', 'Choose another of your accounts');
  if (kind === 'transfer') {
    if (lines.length !== 1) throw invalid('A transfer has one amount');
    return;
  }
  if (other.kind !== 'liability') throw invalid('A debt payment goes to a liability account');
  for (const line of lines.slice(1)) category(line.ledgerAccountId, 'expense');
}

async function goalOr422(db: Db, context: RequestContext, goalId: string | null | undefined) {
  if (goalId && !(await listGoals(db, context.workspaceId)).some((goal) => goal.id === goalId)) throw new ApiError(422, 'INVALID_REFERENCE', 'The goal does not exist');
}

async function ruleOr404(db: Db, context: RequestContext, id: string): Promise<RuleRow> {
  const rule = (await listRules(db, context.workspaceId)).find((candidate) => candidate.id === id);
  if (!rule) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
  return rule;
}

function ruleDto(rule: RuleRow, occurrences: readonly OccurrenceRow[], on: string) {
  const open = occurrences.filter((occurrence) => occurrence.ruleId === rule.id && occurrence.status === 'planned');
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    amountType: rule.amountType,
    accountId: rule.accountId,
    frequency: rule.frequency,
    interval: rule.interval,
    anchorDay: rule.anchorDay,
    startDate: rule.startDate,
    endDate: rule.endDate,
    maxCount: rule.maxCount,
    nonWorkingDay: rule.nonWorkingDay,
    isPayday: rule.isPayday,
    payer: rule.payerName,
    expectedMin_minor: rule.expectedMin,
    expectedMax_minor: rule.expectedMax,
    reminderDays: rule.reminderDays,
    goalId: rule.goalId,
    status: rule.status,
    version: rule.version,
    lines: rule.lines.map((line) => ({ ledgerAccountId: line.ledgerAccountId, amount_minor: line.amount })),
    amount_minor: totalOf(rule.lines),
    nextDue: open.find((occurrence) => occurrence.dueDate >= on)?.dueDate ?? null,
    overdue: open.filter((occurrence) => occurrence.dueDate < on).length,
  };
}

export async function getRules(db: Db, context: RequestContext) {
  const on = await today(db, context);
  await ensureOccurrences(db, context.workspaceId, on);
  const occurrences = await listOccurrences(db, context.workspaceId);
  return (await listRules(db, context.workspaceId)).map((rule) => ruleDto(rule, occurrences, on));
}

export async function createRule(db: Db, context: RequestContext, input: z.infer<typeof createRuleBody>) {
  const chart = await loadChart(db, context.workspaceId);
  const lines = toLines(input.lines);
  checkTemplate(chart, input.kind, input.accountId, lines);
  await goalOr422(db, context, input.goalId);
  if (input.isPayday && (input.kind !== 'income' || !input.payer)) throw new ApiError(422, 'VALIDATION_FAILED', 'A payday rule is an income rule with a payer (SC-2)');
  const id = uuidv7();
  const payer = input.payer ? await ensurePayee(db, context.workspaceId, input.payer) : null;
  await insertRule(db, context.workspaceId, id, fieldsFrom(input, payer?.id ?? null), lines);
  const on = await today(db, context);
  await generateOccurrences(db, context.workspaceId, await ruleOr404(db, context, id), on);
  await event(db, context, 'rule.created', 'rule', id);
  return ruleDto(await ruleOr404(db, context, id), await listOccurrences(db, context.workspaceId, id), on);
}

function fieldsFrom(input: z.infer<typeof createRuleBody>, payerPayeeId: string | null): RuleFields {
  return {
    name: input.name,
    kind: input.kind,
    amountType: input.amountType ?? 'fixed',
    accountId: input.accountId,
    frequency: input.frequency,
    interval: input.interval ?? 1,
    anchorDay: input.anchorDay ?? (input.frequency === 'monthly_day' || input.frequency === 'every_n_months' ? Number(input.startDate.slice(8)) : null),
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    maxCount: input.maxCount ?? null,
    nonWorkingDay: input.nonWorkingDay ?? 'on_date',
    isPayday: input.isPayday ?? false,
    payerPayeeId,
    expectedMin: input.expectedMin_minor ?? null,
    expectedMax: input.expectedMax_minor ?? null,
    reminderDays: input.reminderDays ?? 0,
    goalId: input.goalId ?? null,
  };
}

/** BR-08.6: an edit applies from a date onward, to planned occurrences not edited one by one (GT-30). */
export async function changeRule(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof updateRuleBody>) {
  const rule = await ruleOr404(db, context, id);
  if (rule.status !== 'active') throw new ApiError(409, 'INVALID_STATE', 'This rule has ended');
  const chart = await loadChart(db, context.workspaceId);
  const on = await today(db, context);
  const { effectiveFrom, ...change } = input;
  const lines = change.lines ? toLines(change.lines) : rule.lines;
  const kind = change.kind ?? rule.kind;
  const accountId = change.accountId ?? rule.accountId;
  checkTemplate(chart, kind, accountId, lines);
  await goalOr422(db, context, change.goalId);
  const payer = change.payer ? await ensurePayee(db, context.workspaceId, change.payer) : null;
  const fields: RuleFields = {
    name: change.name ?? rule.name,
    kind,
    amountType: change.amountType ?? rule.amountType,
    accountId,
    frequency: change.frequency ?? rule.frequency,
    interval: change.interval ?? rule.interval,
    anchorDay: change.anchorDay === undefined ? rule.anchorDay : change.anchorDay,
    startDate: change.startDate ?? rule.startDate,
    endDate: change.endDate === undefined ? rule.endDate : change.endDate,
    maxCount: change.maxCount === undefined ? rule.maxCount : change.maxCount,
    nonWorkingDay: change.nonWorkingDay ?? rule.nonWorkingDay,
    isPayday: change.isPayday ?? rule.isPayday,
    payerPayeeId: payer?.id ?? (change.payer === null ? null : rule.payerPayeeId),
    expectedMin: change.expectedMin_minor === undefined ? rule.expectedMin : change.expectedMin_minor,
    expectedMax: change.expectedMax_minor === undefined ? rule.expectedMax : change.expectedMax_minor,
    reminderDays: change.reminderDays ?? rule.reminderDays,
    goalId: change.goalId === undefined ? rule.goalId : change.goalId,
  };
  if (fields.isPayday && (fields.kind !== 'income' || !fields.payerPayeeId)) throw new ApiError(422, 'VALIDATION_FAILED', 'A payday rule is an income rule with a payer (SC-2)');
  if (!(await updateRule(db, context.workspaceId, id, fields, lines, expectedVersion))) throw new ApiError(409, 'VERSION_CONFLICT', 'The rule was changed since you opened it');

  const amount = totalOf(lines);
  const stored = await listOccurrences(db, context.workspaceId, id);
  const from = effectiveFrom ?? on;
  const until = generationHorizon(on);
  const schedule = scheduleOf(fields);
  if (schedule) {
    const plan = regenerate(schedule, stored, from, until);
    for (const date of plan.insert) await insertOccurrence(db, context.workspaceId, id, date, amount, fields.goalId);
    for (const date of plan.update) await applyRuleToOccurrence(db, context.workspaceId, date.id, { dueDate: date.dueDate, amount, goalId: fields.goalId });
    await cancelOccurrences(db, context.workspaceId, plan.cancel);
  } else {
    const [date] = datesOf(fields, until);
    for (const occurrence of stored) await applyRuleToOccurrence(db, context.workspaceId, occurrence.id, { dueDate: date!.dueDate, amount, goalId: fields.goalId });
  }
  await event(db, context, 'rule.updated', 'rule', id);
  return ruleDto(await ruleOr404(db, context, id), await listOccurrences(db, context.workspaceId, id), on);
}

export async function finishRule(db: Db, context: RequestContext, id: string, input: { date?: string | undefined }) {
  const rule = await ruleOr404(db, context, id);
  if (rule.status !== 'active') throw new ApiError(409, 'INVALID_STATE', 'This rule has already ended');
  const on = await today(db, context);
  await endRule(db, context.workspaceId, id, input.date ?? on);
  await event(db, context, 'rule.ended', 'rule', id);
  return ruleDto(await ruleOr404(db, context, id), await listOccurrences(db, context.workspaceId, id), on);
}

function occurrenceDto(occurrence: OccurrenceRow, rule: RuleRow, on: string) {
  const item = plannedItem(occurrence, rule);
  return {
    id: occurrence.id,
    ruleId: rule.id,
    name: rule.name,
    kind: rule.kind,
    frequency: rule.frequency,
    amountType: rule.amountType,
    accountId: item.fromAccountId ?? item.toAccountId,
    toAccountId: item.fromAccountId ? item.toAccountId : null,
    originalDate: occurrence.originalDate,
    dueDate: occurrence.dueDate,
    amount_minor: occurrence.amount,
    status: occurrence.status,
    /** Derived, never stored (BR-08.3). */
    overdue: occurrence.status === 'planned' && occurrence.dueDate < on,
    isPayday: rule.isPayday,
    goalId: occurrence.goalId,
    isEdited: occurrence.isEdited,
    linkedTransactionId: occurrence.linkedTransactionId,
    version: occurrence.version,
    lines: (item.lines ?? []).map((line) => ({ categoryId: line.categoryId, amount_minor: line.amount })),
  };
}

/** FR-11: overdue items first and whatever the range (AC-11.1), then the range. Completed items show only when asked for. */
export async function getOccurrences(db: Db, context: RequestContext, query: { from?: string | undefined; to?: string | undefined; includeClosed?: boolean | undefined }) {
  const on = await today(db, context);
  await ensureOccurrences(db, context.workspaceId, on);
  const rules = new Map((await listRules(db, context.workspaceId)).map((rule) => [rule.id, rule]));
  const from = query.from ?? on;
  const to = query.to ?? new Date(Date.parse(`${on}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = (await listOccurrences(db, context.workspaceId)).filter((occurrence) => {
    if (occurrence.status === 'planned' && occurrence.dueDate < on) return true;
    if (occurrence.dueDate < from || occurrence.dueDate > to) return false;
    return occurrence.status === 'planned' || query.includeClosed === true;
  });
  return rows.map((occurrence) => occurrenceDto(occurrence, rules.get(occurrence.ruleId)!, on));
}

async function occurrenceOr404(db: Db, context: RequestContext, id: string) {
  const occurrence = await getOccurrence(db, context.workspaceId, id);
  if (!occurrence) throw new ApiError(404, 'NOT_FOUND', 'Planned item not found');
  return { occurrence, rule: await ruleOr404(db, context, occurrence.ruleId) };
}

/** R5: a payment linked to a goal releases the goal money it was covered by. */
async function settleGoal(db: Db, context: RequestContext, occurrence: OccurrenceRow, rule: RuleRow, tx: { id: string; amount: number }) {
  if (!occurrence.goalId) return 0;
  return releaseGoalMoney(db, context, { goalId: occurrence.goalId, amount: tx.amount, paidFromAccountId: rule.kind === 'income' ? null : rule.accountId, transactionId: tx.id });
}

/** BR-08.5: creates the actual from the template; the amount and date can change (E-51). */
export async function confirmOccurrence(db: Db, context: RequestContext, id: string, input: z.infer<typeof confirmOccurrenceBody>) {
  const { occurrence, rule } = await occurrenceOr404(db, context, id);
  if (occurrence.status !== 'planned') throw new ApiError(409, 'INVALID_STATE', 'This item is not planned any more');
  const on = await today(db, context);
  const date = input.date ?? (occurrence.dueDate > on ? on : occurrence.dueDate);
  const accountId = input.accountId ?? rule.accountId;
  let lines = input.lines ? toLines(input.lines) : rule.lines;
  const amount = input.amount_minor ?? (input.lines ? undefined : occurrence.amount);
  if (amount !== undefined && !input.lines) {
    if (lines.length === 1) lines = [{ ledgerAccountId: lines[0]!.ledgerAccountId, amount }];
    else if (amount !== totalOf(lines)) throw new ApiError(422, 'VALIDATION_FAILED', 'This item has several lines: send the new lines instead of one amount');
  }
  const chart = await loadChart(db, context.workspaceId);
  checkTemplate(chart, rule.kind, accountId, lines);
  const text = { description: rule.name, ...(rule.payerName ? { payee: rule.payerName } : {}) };
  const asCategories = (from: readonly RuleLine[]) => from.map((line) => ({ categoryId: line.ledgerAccountId, amount_minor: line.amount }));
  const created =
    rule.kind === 'transfer'
      ? await recordTransfer(db, context, { date, fromAccountId: accountId, toAccountId: lines[0]!.ledgerAccountId, amount_minor: lines[0]!.amount, ...text }, 'occurrence')
      : rule.kind === 'debt_payment'
        ? await recordTransaction(db, context, { kind: 'debt_payment', date, fromAccountId: accountId, liabilityAccountId: lines[0]!.ledgerAccountId, principal_minor: lines[0]!.amount, extras: asCategories(lines.slice(1)), ...text }, 'occurrence')
        : await recordTransaction(db, context, { kind: rule.kind, date, accountId, lines: asCategories(lines), ...text }, 'occurrence');
  if (!(await completeOccurrence(db, context.workspaceId, id, created.id))) throw new ApiError(409, 'ALREADY_LINKED', 'This item or transaction is already linked');
  const released = input.useGoalMoney === false ? 0 : await settleGoal(db, context, occurrence, rule, { id: created.id, amount: totalOf(lines) });
  await event(db, context, 'occurrence.confirmed', 'occurrence', id);
  return { transaction: created, occurrenceId: id, released_minor: released, ...(await afterPayment(db, context, occurrence, rule, totalOf(lines), released)) };
}

/** GT-66 (b): goal money sat on a non-spendable account, so offer to bring it over. */
async function afterPayment(db: Db, context: RequestContext, occurrence: OccurrenceRow, rule: RuleRow, amount: number, released: number) {
  if (!occurrence.goalId || released === 0 || rule.kind === 'income') return {};
  const chart = await loadChart(db, context.workspaceId);
  const paidFrom = chart.find(rule.accountId)?.account;
  return paidFrom?.spendable ? { moveMoneyHint_minor: Math.min(amount, released) } : {};
}

/** BR-08.4: one transaction per occurrence, each way (AC-08.4). */
export async function linkOccurrence(db: Db, context: RequestContext, id: string, input: { transactionId: string; useGoalMoney?: boolean | undefined }) {
  const { occurrence, rule } = await occurrenceOr404(db, context, id);
  if (occurrence.status !== 'planned') throw new ApiError(409, 'ALREADY_LINKED', 'This item is not planned any more');
  const record = await loadTransactionRecord(db, context.workspaceId, input.transactionId);
  if (!record) throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  if (record.tx.status !== 'posted') throw new ApiError(422, 'VALIDATION_FAILED', 'Only a posted transaction can be linked');
  const posting = record.tx.postings.find((p) => p.ledgerAccountId === rule.accountId) ?? record.tx.postings.find((p) => rule.lines[0]?.ledgerAccountId === p.ledgerAccountId && rule.kind === 'transfer');
  if (!posting) throw new ApiError(422, 'VALIDATION_FAILED', 'This transaction is on another account (M-1)');
  if (!(await completeOccurrence(db, context.workspaceId, id, input.transactionId))) throw new ApiError(409, 'ALREADY_LINKED', 'This transaction is already linked to a planned item');
  const amount = Math.abs(posting.amount);
  const released = input.useGoalMoney === false ? 0 : await settleGoal(db, context, occurrence, rule, { id: input.transactionId, amount });
  await event(db, context, 'occurrence.linked', 'occurrence', id);
  const on = await today(db, context);
  return { ...occurrenceDto((await getOccurrence(db, context.workspaceId, id))!, rule, on), released_minor: released };
}

/** BR-08.8, M-8: the item is planned again, and the actual stays. Audited. */
export async function unlinkOccurrence(db: Db, context: RequestContext, id: string) {
  const { rule } = await occurrenceOr404(db, context, id);
  if (!(await setOccurrenceStatus(db, context.workspaceId, id, 'completed', 'planned'))) throw new ApiError(409, 'INVALID_STATE', 'This item is not linked');
  await event(db, context, 'occurrence.unlinked', 'occurrence', id);
  return occurrenceDto((await getOccurrence(db, context.workspaceId, id))!, rule, await today(db, context));
}

export async function skipOccurrence(db: Db, context: RequestContext, id: string) {
  const { rule } = await occurrenceOr404(db, context, id);
  if (!(await setOccurrenceStatus(db, context.workspaceId, id, 'planned', 'skipped'))) throw new ApiError(409, 'INVALID_STATE', 'This item is not planned any more');
  await event(db, context, 'occurrence.skipped', 'occurrence', id);
  return occurrenceDto((await getOccurrence(db, context.workspaceId, id))!, rule, await today(db, context));
}

/** An occurrence edited by itself keeps its values when the rule changes (BR-08.6). */
export async function changeOccurrence(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof editOccurrenceBody>) {
  const { rule } = await occurrenceOr404(db, context, id);
  await goalOr422(db, context, input.goalId);
  if (!(await updateOccurrence(db, context.workspaceId, id, { amount: input.amount_minor, dueDate: input.dueDate, goalId: input.goalId, expectedVersion }))) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This item was changed since you opened it, or is no longer planned');
  }
  await event(db, context, 'occurrence.edited', 'occurrence', id);
  return occurrenceDto((await getOccurrence(db, context.workspaceId, id))!, rule, await today(db, context));
}

export async function getSafeToSpend(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const on = todayIn(workspace.timezone);
  const chart = await loadChart(db, context.workspaceId);
  const records = await loadTransactionRecords(db, context.workspaceId);
  const ledger = new Ledger(chart, records.map((record) => record.tx));
  return { at: on, currency: workspace.currency, ...(await safeToSpendFigures(db, context, ledger, workspace, on, records)) };
}

/** FR-13 (a Should): the daily projection, with its lowest point. */
export async function getProjection(db: Db, context: RequestContext, days: number) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const on = todayIn(workspace.timezone);
  await ensureOccurrences(db, context.workspaceId, on);
  const rules = new Map((await listRules(db, context.workspaceId)).map((rule) => [rule.id, rule]));
  const planned = (await listOccurrences(db, context.workspaceId)).filter((occurrence) => occurrence.status === 'planned').map((occurrence) => plannedItem(occurrence, rules.get(occurrence.ruleId)!));
  const transactions: Transaction[] = await loadTransactions(db, context.workspaceId);
  const result = projection({ ledger: new Ledger(await loadChart(db, context.workspaceId), transactions), today: on, days, planned, countSavingsTransfers: workspace.stsCountSavingsTransfers });
  return {
    days: result.days.map((day) => ({ date: day.date, commitmentsOnly_minor: day.commitmentsOnly, withIncome_minor: day.withIncome })),
    lowest: { date: result.lowest.date, amount_minor: result.lowest.amount },
  };
}
