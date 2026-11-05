/**
 * Archiving accounts and categories, and merging categories (FR-05, FR-19, E-58, E-59, GT-45).
 * Nothing is deleted: archived items keep their history and only leave the pickers.
 */
import { Ledger, todayIn } from '@fintrack/domain';
import {
  ensureOccurrences,
  getWorkspace,
  listBudgetLimits,
  listPayees,
  loadAllocations,
  loadPlannedItems,
  setBudgetLimit,
  mergePayee,
  payeeNameTaken,
  updatePayee,
  loadChart,
  loadTransactions,
  mergeCategory,
  recordAuditEvent,
  setArchived,
  type Db,
  type RequestContext,
} from '@fintrack/db';
import { ApiError } from './http.ts';
import { accountDto, categoryDto } from './services.ts';

export const getPayees = (db: Db, context: RequestContext) => listPayees(db, context.workspaceId);

async function payeeOr404(db: Db, context: RequestContext, id: string) {
  const payee = (await listPayees(db, context.workspaceId)).find((candidate) => candidate.id === id);
  if (!payee) throw new ApiError(404, 'NOT_FOUND', 'Payee not found');
  return payee;
}

/** Renames a payee or sets its default category; a chosen default stops the learning (BR-05.6). */
export async function changePayee(db: Db, context: RequestContext, id: string, expectedVersion: number, input: { name?: string | undefined; defaultCategoryId?: string | null | undefined }) {
  await payeeOr404(db, context, id);
  if (input.defaultCategoryId && !(await loadChart(db, context.workspaceId)).find(input.defaultCategoryId)?.category) {
    throw new ApiError(422, 'INVALID_REFERENCE', 'The category does not exist');
  }
  if (input.name && (await payeeNameTaken(db, context.workspaceId, input.name, id))) {
    throw new ApiError(409, 'PAYEE_NAME_TAKEN', 'Another payee has this name. Merge them instead');
  }
  const version = await updatePayee(db, context.workspaceId, id, { ...input, expectedVersion });
  if (version === null) throw new ApiError(409, 'VERSION_CONFLICT', 'The payee was changed since you opened it');
  return payeeOr404(db, context, id);
}

export async function mergePayees(db: Db, context: RequestContext, fromId: string, intoId: string) {
  if (fromId === intoId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a different payee to merge into');
  await payeeOr404(db, context, fromId);
  await payeeOr404(db, context, intoId);
  const moved = await mergePayee(db, context.workspaceId, fromId, intoId);
  await event(db, context, 'payee.merged', 'payee', fromId);
  return { moved };
}

/** The latest possible date, so a balance includes every posting whatever its date. */
const ALL_TIME = '9999-12-31';

function event(db: Db, context: RequestContext, type: string, objectType: string, objectId: string) {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType, objectId });
}

/** Archive needs a zero balance (AC-19.3, E-58); unarchiving is always allowed (FR-19). */
export async function setAccountArchived(db: Db, context: RequestContext, id: string, archived: boolean) {
  const chart = await loadChart(db, context.workspaceId);
  const account = chart.find(id);
  if (!account?.account) throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  const ledger = new Ledger(chart, await loadTransactions(db, context.workspaceId));
  if (archived && !account.archived && ledger.rawBalance(id, ALL_TIME) !== 0) {
    throw new ApiError(409, 'ARCHIVE_BLOCKED', 'Bring the balance to 0 first: transfer the rest elsewhere, or reconcile with an adjustment', {
      balance_minor: ledger.balance(id, ALL_TIME),
    });
  }
  if (archived && !account.archived) {
    const today = todayIn((await getWorkspace(db, context.workspaceId)).timezone);
    await ensureOccurrences(db, context.workspaceId, today);
    const planned = await loadPlannedItems(db, context.workspaceId);
    if (planned.some((item) => item.fromAccountId === id || item.toAccountId === id)) throw new ApiError(409, 'ARCHIVE_BLOCKED', 'End the planned items on this account first (FR-19)');
    if ((await loadAllocations(db, context.workspaceId)).some((allocation) => allocation.accountId === id)) throw new ApiError(409, 'ARCHIVE_BLOCKED', 'Release the goal money on this account first (FR-19)');
  }
  if ((account.archived ?? false) !== archived) {
    await setArchived(db, context.workspaceId, id, archived);
    await event(db, context, archived ? 'account.archived' : 'account.unarchived', 'account', id);
    if (archived) chart.markArchived(id);
  }
  const today = todayIn((await getWorkspace(db, context.workspaceId)).timezone);
  return accountDto(ledger, archived ? chart.get(id) : { ...chart.get(id), archived: false }, today);
}

/** Archiving a category changes no posting (E-59). A parent goes only after its subcategories. */
export async function setCategoryArchived(db: Db, context: RequestContext, id: string, archived: boolean) {
  const chart = await loadChart(db, context.workspaceId);
  const category = chart.find(id);
  if (!category?.category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  if (archived && chart.all().some((other) => other.category?.parentId === id && !other.archived)) {
    throw new ApiError(409, 'ARCHIVE_BLOCKED', 'Archive or merge its subcategories first');
  }
  const parent = category.category.parentId ? chart.get(category.category.parentId) : undefined;
  if (!archived && parent?.archived) throw new ApiError(409, 'ARCHIVE_BLOCKED', `Unarchive ${parent.name} first`);
  if ((category.archived ?? false) !== archived) {
    await setArchived(db, context.workspaceId, id, archived);
    await event(db, context, archived ? 'category.archived' : 'category.unarchived', 'category', id);
    // FR-07: archiving ends an active budget from next month, and keeps this one.
    if (archived && category.kind === 'expense') {
      const today = todayIn((await getWorkspace(db, context.workspaceId)).timezone);
      const [year, month] = today.split('-').map(Number) as [number, number];
      const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
      if ((await listBudgetLimits(db, context.workspaceId)).some((row) => row.categoryId === id && row.limit !== null)) await setBudgetLimit(db, context.workspaceId, id, next, null, [80, 100], true);
    }
  }
  return categoryDto({ ...category, archived });
}

/**
 * Merges one category into another of the same kind (BR-05.4, E-59, GT-45 b): its whole history
 * moves, amounts unchanged, so Income, Expenses and Net Worth are the same for every period.
 * The merged category is archived. Audited.
 */
export async function mergeCategories(db: Db, context: RequestContext, fromId: string, intoId: string) {
  const chart = await loadChart(db, context.workspaceId);
  const from = chart.find(fromId);
  const into = chart.find(intoId);
  if (!from?.category || !into?.category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  if (fromId === intoId) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a different category to merge into');
  if (from.kind !== into.kind) throw new ApiError(422, 'VALIDATION_FAILED', 'Only categories of the same kind can be merged (BR-05.4)');
  if (into.archived) throw new ApiError(409, 'ARCHIVE_BLOCKED', `Unarchive ${into.name} first`);
  if (chart.all().some((other) => other.category?.parentId === fromId)) {
    throw new ApiError(409, 'ARCHIVE_BLOCKED', 'Merge or move its subcategories first');
  }
  const moved = await mergeCategory(db, context.workspaceId, fromId, intoId);
  await event(db, context, 'category.merged', 'category', fromId);
  return { from: categoryDto({ ...from, archived: true }), into: categoryDto(into), movedLines: moved };
}
