/**
 * Requesting and cancelling account deletion (Stage 2 §8.6, GAP-5, AC-01.6). The purge itself
 * is a maintenance job (purgeDeletedWorkspaces).
 */
import { DELETION_WINDOW_DAYS, getWorkspace, recordAuditEvent, setDeletionPending, type Db, type RequestContext } from '@fintrack/db';
import { ApiError } from './http.ts';
import { workspaceDto } from './services.ts';

function event(db: Db, context: RequestContext, type: string) {
  return recordAuditEvent(db, { workspaceId: context.workspaceId, userId: context.userId, type, objectType: 'workspace', objectId: context.workspaceId });
}

export async function requestDeletion(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  if (workspace.status === 'active') {
    await setDeletionPending(db, context.workspaceId, true);
    await event(db, context, 'account.deletion_requested');
  }
  return workspaceDto(await getWorkspace(db, context.workspaceId));
}

export async function cancelDeletion(db: Db, context: RequestContext) {
  const workspace = await getWorkspace(db, context.workspaceId);
  if (workspace.status !== 'deletion_pending') throw new ApiError(409, 'INVALID_STATE', 'No deletion is scheduled');
  const age = Date.now() - Date.parse(workspace.deletionRequestedAt!);
  if (age > DELETION_WINDOW_DAYS * 86_400_000) throw new ApiError(409, 'INVALID_STATE', 'The 7 days to cancel have ended');
  await setDeletionPending(db, context.workspaceId, false);
  await event(db, context, 'account.deletion_cancelled');
  return workspaceDto(await getWorkspace(db, context.workspaceId));
}
