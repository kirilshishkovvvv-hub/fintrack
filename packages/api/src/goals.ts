/**
 * Savings goals and virtual allocations (§8). Every check on an allocation runs inside the
 * workspace lock, so a parallel expense can't invalidate it (Stage 2 §7.5). No goal operation
 * touches a posting (AC-09.6).
 */
import {
  AllocationExceedsUnallocated,
  assertCanAllocate,
  backedOnAccount,
  goalProjection,
  Ledger,
  todayIn,
  type Allocation,
} from '@fintrack/domain';
import {
  allocationHistory,
  changeAllocation,
  dedicatedAccounts,
  ensureOccurrences,
  getWorkspace,
  insertGoal,
  listGoals,
  listRules,
  loadAllocations,
  loadChart,
  loadPlannedItems,
  loadTransactionRecord,
  loadTransactions,
  recordAuditEvent,
  setDedicatedGoal,
  setGoalFunding,
  setOccurrenceGoal,
  setRuleGoal,
  updateGoal,
  uuidv7,
  type Db,
  type GoalRow,
  type RequestContext,
} from '@fintrack/db';
import type { z } from 'zod';
import { ApiError } from './http.ts';
import type { allocationBody, createGoalBody, linkPaymentBody, updateGoalBody } from './schemas.ts';

function event(db: Db, context: RequestContext, type: string, goalId: string) {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType: 'goal', objectId: goalId });
}

async function ledgerAt(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  const chart = await loadChart(db, context.workspaceId);
  return { today: todayIn(workspace.timezone), chart, ledger: new Ledger(chart, await loadTransactions(db, context.workspaceId)) };
}

async function goalOr404(db: Db, context: RequestContext, id: string): Promise<GoalRow> {
  const goal = (await listGoals(db, context.workspaceId)).find((candidate) => candidate.id === id);
  if (!goal) throw new ApiError(404, 'NOT_FOUND', 'Goal not found');
  return goal;
}

/** Goals with backed amounts, shortfalls, projections and linked payments (R5). */
export async function getGoals(db: Db, context: RequestContext) {
  const { today, ledger, chart } = await ledgerAt(db, context);
  await ensureOccurrences(db, context.workspaceId, today);
  const goals = await listGoals(db, context.workspaceId);
  const allocations = await loadAllocations(db, context.workspaceId);
  const dedicated = await dedicatedAccounts(db, context.workspaceId);
  const planned = await loadPlannedItems(db, context.workspaceId);
  const backedByAccount = new Map<string, Map<string, number>>();
  for (const accountId of new Set(allocations.map((allocation) => allocation.accountId))) {
    backedByAccount.set(accountId, backedOnAccount(ledger.balance(accountId, today), allocations.filter((allocation) => allocation.accountId === accountId)));
  }
  return goals.map((goal) => {
    const own = allocations.filter((allocation) => allocation.goalId === goal.id);
    const rows = own.map((allocation) => {
      const backed = backedByAccount.get(allocation.accountId)?.get(goal.id) ?? 0;
      return { accountId: allocation.accountId, name: chart.find(allocation.accountId)?.name ?? '', amount_minor: allocation.amount, backed_minor: backed };
    });
    const accounts = (dedicated.get(goal.id) ?? []).map((accountId) => ({ accountId, name: chart.find(accountId)?.name ?? '', balance_minor: ledger.balance(accountId, today) }));
    const allocated = own.reduce((sum, allocation) => sum + allocation.amount, 0);
    const backed = rows.reduce((sum, row) => sum + row.backed_minor, 0);
    const progress = goal.fundingMethod === 'dedicated' ? accounts.reduce((sum, account) => sum + Math.max(0, account.balance_minor), 0) : backed;
    const projection = goal.status === 'active' ? goalProjection({ target: goal.target, progress, monthly: goal.monthly, targetDate: goal.targetDate, today }) : null;
    // R5: coverage runs in due-date order, and each cent covers one payment.
    let coverage = backed;
    const payments = planned
      .filter((item) => item.goalId === goal.id)
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
      .map((item) => {
        const covered = Math.min(coverage, item.amount);
        coverage -= covered;
        return { occurrenceId: item.id, name: item.name, dueDate: item.dueDate, amount_minor: item.amount, covered_minor: covered };
      });
    return {
      id: goal.id,
      name: goal.name,
      funding: goal.fundingMethod,
      target_minor: goal.target,
      targetDate: goal.targetDate,
      monthly_minor: goal.monthly,
      status: goal.status,
      /** §8.9: worked out, so it can never disagree with the money. */
      state: goal.status === 'archived' ? 'archived' : goal.target !== null && progress >= goal.target ? 'reached' : allocated === 0 && goal.used > 0 ? 'used' : 'active',
      version: goal.version,
      allocated_minor: allocated,
      backed_minor: backed,
      shortfall_minor: goal.fundingMethod === 'virtual' ? allocated - backed : 0,
      progress_minor: progress,
      used_minor: goal.used,
      allocations: rows,
      accounts,
      projection,
      payments,
    };
  });
}

async function linkDedicated(db: Db, context: RequestContext, goalId: string, accountId: string) {
  const chart = await loadChart(db, context.workspaceId);
  const account = chart.find(accountId);
  if (!account?.account || account.archived) throw new ApiError(422, 'INVALID_REFERENCE', 'The account does not exist');
  if (account.account.class !== 'cash') throw new ApiError(422, 'VALIDATION_FAILED', 'Only cash accounts can be dedicated to a goal (G-D4)');
  const dedicated = await dedicatedAccounts(db, context.workspaceId);
  if ([...dedicated.values()].some((accounts) => accounts.includes(accountId))) throw new ApiError(409, 'INVALID_STATE', 'This account is already dedicated to a goal (G-D2)');
  if ((await loadAllocations(db, context.workspaceId)).some((allocation) => allocation.accountId === accountId)) {
    throw new ApiError(409, 'INVALID_STATE', 'Release or move the allocations on this account first (G-D3)');
  }
  await setDedicatedGoal(db, context.workspaceId, accountId, goalId, false);
}

export async function createGoal(db: Db, context: RequestContext, input: z.infer<typeof createGoalBody>) {
  const id = uuidv7();
  await insertGoal(db, context.workspaceId, id, {
    name: input.name,
    fundingMethod: input.funding,
    target: input.target_minor ?? null,
    targetDate: input.targetDate ?? null,
    monthly: input.monthly_minor ?? null,
  });
  if (input.funding === 'virtual' && input.accountIds?.length) throw new ApiError(422, 'VALIDATION_FAILED', 'A virtual goal has allocations, not accounts (G-1)');
  for (const accountId of input.accountIds ?? []) await linkDedicated(db, context, id, accountId);
  await event(db, context, 'goal.created', id);
  return (await getGoals(db, context)).find((goal) => goal.id === id)!;
}

export async function changeGoal(db: Db, context: RequestContext, id: string, expectedVersion: number, input: z.infer<typeof updateGoalBody>) {
  const goal = await goalOr404(db, context, id);
  const updated = await updateGoal(
    db,
    context.workspaceId,
    id,
    {
      name: input.name ?? goal.name,
      target: input.target_minor === undefined ? goal.target : input.target_minor,
      targetDate: input.targetDate === undefined ? goal.targetDate : input.targetDate,
      monthly: input.monthly_minor === undefined ? goal.monthly : input.monthly_minor,
    },
    expectedVersion,
  );
  if (!updated) throw new ApiError(409, 'VERSION_CONFLICT', 'The goal was changed since you opened it');
  await event(db, context, 'goal.updated', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

/** §8.9: all allocations must be released first; dedicated accounts are unlinked. */
export async function archiveGoal(db: Db, context: RequestContext, id: string) {
  const goal = await goalOr404(db, context, id);
  if ((await loadAllocations(db, context.workspaceId)).some((allocation) => allocation.goalId === id)) {
    throw new ApiError(409, 'ARCHIVE_BLOCKED', 'Release the allocations of this goal first (§8.9)');
  }
  for (const accountId of (await dedicatedAccounts(db, context.workspaceId)).get(id) ?? []) await setDedicatedGoal(db, context.workspaceId, accountId, null, false);
  await updateGoal(db, context.workspaceId, id, { name: goal.name, target: goal.target, targetDate: goal.targetDate, monthly: goal.monthly, status: 'archived' }, goal.version);
  await event(db, context, 'goal.archived', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

/** G-D6: the account returns to the setting the user chooses, and progress falls with it. */
export async function unlinkAccount(db: Db, context: RequestContext, id: string, input: { accountId: string; spendable: boolean }) {
  await goalOr404(db, context, id);
  if (!((await dedicatedAccounts(db, context.workspaceId)).get(id) ?? []).includes(input.accountId)) throw new ApiError(422, 'INVALID_REFERENCE', 'This account is not dedicated to this goal');
  await setDedicatedGoal(db, context.workspaceId, input.accountId, null, input.spendable);
  await event(db, context, 'goal.account_unlinked', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

export async function linkAccount(db: Db, context: RequestContext, id: string, input: { accountId: string }) {
  const goal = await goalOr404(db, context, id);
  if (goal.fundingMethod !== 'dedicated') throw new ApiError(422, 'VALIDATION_FAILED', 'A virtual goal has allocations, not accounts (G-1)');
  await linkDedicated(db, context, id, input.accountId);
  await event(db, context, 'goal.account_linked', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

/**
 * §8.9, the guided conversions. To virtual: each account is unlinked and allocated in full. To
 * dedicated: the target must hold nothing for another goal, and this goal's allocations go.
 */
export async function convertGoal(db: Db, context: RequestContext, id: string, input: { to: 'virtual' | 'dedicated'; accountId?: string | undefined }) {
  const goal = await goalOr404(db, context, id);
  if (goal.fundingMethod === input.to) throw new ApiError(409, 'INVALID_STATE', 'The goal already works that way');
  const { today, ledger } = await ledgerAt(db, context);
  if (input.to === 'virtual') {
    const accounts = (await dedicatedAccounts(db, context.workspaceId)).get(id) ?? [];
    await setGoalFunding(db, context.workspaceId, id, 'virtual');
    for (const accountId of accounts) {
      await setDedicatedGoal(db, context.workspaceId, accountId, null, false);
      const balance = Math.max(0, ledger.balance(accountId, today));
      if (balance > 0) await changeAllocation(db, context.workspaceId, { goalId: id, accountId, delta: balance, event: 'create', userId: context.userId, reason: 'conversion' });
    }
  } else {
    if (!input.accountId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose the account to dedicate');
    const allocations = await loadAllocations(db, context.workspaceId);
    if (allocations.some((allocation) => allocation.accountId === input.accountId && allocation.goalId !== id)) throw new ApiError(409, 'INVALID_STATE', 'That account holds money for another goal (§8.9)');
    for (const allocation of allocations.filter((row) => row.goalId === id)) {
      await changeAllocation(db, context.workspaceId, { goalId: id, accountId: allocation.accountId, delta: -allocation.amount, event: 'release', userId: context.userId, reason: 'conversion' });
    }
    await setGoalFunding(db, context.workspaceId, id, 'dedicated');
    await linkDedicated(db, context, id, input.accountId);
  }
  await event(db, context, 'goal.converted', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

const on = (allocations: readonly Allocation[], accountId: string) => allocations.filter((allocation) => allocation.accountId === accountId).reduce((sum, allocation) => sum + allocation.amount, 0);

/** G-V2, with the amount the refusal names (`ALLOCATION_EXCEEDS_UNALLOCATED`). */
function checkIncrease(balance: number, allocated: number, increase: number) {
  try {
    assertCanAllocate(balance, allocated, increase);
  } catch (error) {
    if (error instanceof AllocationExceedsUnallocated) throw new ApiError(409, 'ALLOCATION_EXCEEDS_UNALLOCATED', 'There is not enough unallocated money on this account (G-V2)', { available_minor: error.available });
    throw error;
  }
}

/** Create, increase, decrease, release, move (G-V2 to G-V6), and connecting spending to a goal after the fact (G-P3). */
export async function allocate(db: Db, context: RequestContext, id: string, input: z.infer<typeof allocationBody>) {
  const goal = await goalOr404(db, context, id);
  if (goal.status !== 'active') throw new ApiError(409, 'INVALID_STATE', 'This goal is archived');
  if (goal.fundingMethod !== 'virtual') throw new ApiError(422, 'VALIDATION_FAILED', 'A dedicated goal holds no allocations (G-1)');
  const { today, ledger, chart } = await ledgerAt(db, context);
  const allocations = await loadAllocations(db, context.workspaceId);
  const account = chart.find(input.accountId);
  if (!account?.account) throw new ApiError(422, 'INVALID_REFERENCE', 'The account does not exist');
  const current = allocations.find((allocation) => allocation.goalId === id && allocation.accountId === input.accountId)?.amount ?? 0;
  const write = (accountId: string, goalId: string, delta: number, kind: Parameters<typeof changeAllocation>[2]['event'], transactionId?: string) =>
    changeAllocation(db, context.workspaceId, { goalId, accountId, delta, event: kind, userId: context.userId, reason: input.reason ?? null, transactionId: transactionId ?? null });
  const usable = (accountId: string) => {
    const target = chart.find(accountId);
    if (!target?.account || target.archived) throw new ApiError(422, 'INVALID_REFERENCE', 'The account does not exist');
    if (target.account.class !== 'cash') throw new ApiError(422, 'VALIDATION_FAILED', 'Allocations are only for cash accounts (G-V1)');
  };
  const dedicated = [...(await dedicatedAccounts(db, context.workspaceId)).values()].flat();
  const notDedicated = (accountId: string) => {
    if (dedicated.includes(accountId)) throw new ApiError(409, 'INVALID_STATE', 'This account is dedicated to a goal, and holds no allocations (G-D3)');
  };

  switch (input.operation) {
    case 'allocate': {
      usable(input.accountId);
      notDedicated(input.accountId);
      checkIncrease(ledger.balance(input.accountId, today), on(allocations, input.accountId), input.amount_minor!);
      await write(input.accountId, id, input.amount_minor!, current === 0 ? 'create' : 'increase');
      break;
    }
    case 'decrease': {
      if (input.amount_minor! > current) throw new ApiError(422, 'VALIDATION_FAILED', 'An allocation cannot go below 0 (G-V3)');
      await write(input.accountId, id, -input.amount_minor!, 'decrease');
      break;
    }
    case 'release': {
      const amount = input.amount_minor ?? current;
      if (amount === 0 || amount > current) throw new ApiError(422, 'VALIDATION_FAILED', 'There is nothing to release, or too much (G-V3)');
      await write(input.accountId, id, -amount, 'release');
      break;
    }
    case 'move': {
      const toGoal = input.toGoalId ?? id;
      const toAccount = input.toAccountId ?? input.accountId;
      if (toGoal === id && toAccount === input.accountId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose another goal or account');
      if (input.amount_minor! > current) throw new ApiError(422, 'VALIDATION_FAILED', 'Only what is allocated can be moved');
      if (toGoal !== id) {
        const other = await goalOr404(db, context, toGoal);
        if (other.status !== 'active' || other.fundingMethod !== 'virtual') throw new ApiError(422, 'VALIDATION_FAILED', 'That goal cannot hold allocations');
      }
      usable(toAccount);
      notDedicated(toAccount);
      // G-V4: the same check as a new allocation; on one account the source frees what it gives.
      const before = on(allocations, toAccount) - (toAccount === input.accountId ? input.amount_minor! : 0);
      checkIncrease(ledger.balance(toAccount, today), before, input.amount_minor!);
      await write(input.accountId, id, -input.amount_minor!, 'move');
      await write(toAccount, toGoal, input.amount_minor!, 'move');
      break;
    }
    case 'use': {
      if (!input.transactionId) throw new ApiError(422, 'VALIDATION_FAILED', 'Name the transaction this money paid for (G-P3)');
      const record = await loadTransactionRecord(db, context.workspaceId, input.transactionId);
      if (!record || record.tx.status !== 'posted') throw new ApiError(422, 'INVALID_REFERENCE', 'The transaction does not exist');
      const amount = input.amount_minor ?? current;
      if (amount === 0 || amount > current) throw new ApiError(422, 'VALIDATION_FAILED', 'There is nothing to release, or too much (G-V3)');
      await write(input.accountId, id, -amount, 'use_goal_money', input.transactionId);
      break;
    }
  }
  await event(db, context, 'goal.allocation_changed', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

/** R5, "Save for a bill": one goal per payment; a goal can have many (§7.5). */
export async function linkPayment(db: Db, context: RequestContext, id: string, input: z.infer<typeof linkPaymentBody>) {
  await goalOr404(db, context, id);
  const goalId = input.unlink ? null : id;
  if (input.ruleId) {
    if (!(await listRules(db, context.workspaceId)).some((rule) => rule.id === input.ruleId)) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
    await setRuleGoal(db, context.workspaceId, input.ruleId, goalId);
  } else if (!(await setOccurrenceGoal(db, context.workspaceId, input.occurrenceId!, goalId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Planned item not found');
  }
  await event(db, context, 'goal.payment_linked', id);
  return (await getGoals(db, context)).find((row) => row.id === id)!;
}

export async function goalHistory(db: Db, context: RequestContext, id: string) {
  await goalOr404(db, context, id);
  return allocationHistory(db, context.workspaceId, id);
}

