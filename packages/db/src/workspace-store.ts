import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';
import type { Currency } from './ledger-store.ts';

export interface WorkspaceRow {
  id: string;
  name: string;
  currency: Currency;
  timezone: string;
  protectedReserveMinor: number;
}

/** The workspaces the current user belongs to (needs app.user_id; see withUser). */
export async function workspaceIdsForUser(db: Db, userId: string): Promise<string[]> {
  const result = await db.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM fin.memberships WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return result.rows.map((row) => row.workspace_id);
}

/** The workspace, filtered explicitly as well as by row-level security. */
export async function getWorkspace(db: Db, workspaceId: string): Promise<WorkspaceRow> {
  const result = await db.query<{
    id: string;
    name: string;
    currency: Currency;
    timezone: string;
    protected_reserve_minor: string;
  }>('SELECT id, name, currency, timezone, protected_reserve_minor::text FROM fin.workspaces WHERE id = $1', [workspaceId]);
  const row = result.rows[0];
  if (!row) throw new Error('No workspace in the current context');
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    timezone: row.timezone,
    protectedReserveMinor: Number(row.protected_reserve_minor),
  };
}

/** Audit events carry IDs and event types, never amounts or descriptions (Stage 2 §8.5). */
export async function recordAuditEvent(
  db: Db,
  event: { workspaceId: string | null; userId: string; type: string; objectType?: string; objectId?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO fin.audit_events (id, workspace_id, user_id, event_type, object_type, object_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), event.workspaceId, event.userId, event.type, event.objectType ?? null, event.objectId ?? null],
  );
}

export class IdempotencyConflict extends Error {
  override name = 'IdempotencyConflict';
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Runs `work` once per (user, key). A repeat with the same request returns the stored
 * response; the same key with a different request is a conflict (Stage 2 §7.5).
 * Must run inside the same database transaction as the work, under the workspace lock.
 */
export async function idempotent(
  db: Db,
  keyInfo: { userId: string; workspaceId: string; key: string; requestHash: string },
  work: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const existing = await db.query<{ request_hash: string; status_code: number; response: unknown }>(
    `SELECT request_hash, status_code, response FROM fin.idempotency_records
      WHERE user_id = $1 AND idem_key = $2 AND expires_at > now()`,
    [keyInfo.userId, keyInfo.key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== keyInfo.requestHash) {
      throw new IdempotencyConflict('This idempotency key was already used for a different request');
    }
    return { status: row.status_code, body: row.response, replayed: true };
  }
  const response = await work();
  await db.query(
    `INSERT INTO fin.idempotency_records (user_id, idem_key, workspace_id, request_hash, status_code, response)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, idem_key) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id, request_hash = EXCLUDED.request_hash,
           status_code = EXCLUDED.status_code, response = EXCLUDED.response,
           created_at = now(), expires_at = now() + interval '7 days'
     WHERE fin.idempotency_records.expires_at <= now()`,
    [keyInfo.userId, keyInfo.key, keyInfo.workspaceId, keyInfo.requestHash, response.status, JSON.stringify(response.body)],
  );
  return { ...response, replayed: false };
}
