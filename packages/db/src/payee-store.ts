/** Payees (FR-05, BR-05.6): created from entry, with a default category set or learned, and mergeable. */
import { normalizeDescription } from '@fintrack/domain';
import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';

export interface PayeeRow {
  id: string;
  name: string;
  defaultCategoryId: string | null;
  defaultIsExplicit: boolean;
  archived: boolean;
  version: number;
}

export async function listPayees(db: Db, workspaceId: string): Promise<PayeeRow[]> {
  const result = await db.query<{ id: string; name: string; default_category_id: string | null; default_is_explicit: boolean; is_archived: boolean; version: number }>(
    'SELECT id, name, default_category_id, default_is_explicit, is_archived, version FROM fin.payees WHERE workspace_id = $1 ORDER BY normalized_name',
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    defaultCategoryId: row.default_category_id,
    defaultIsExplicit: row.default_is_explicit,
    archived: row.is_archived,
    version: row.version,
  }));
}

/** The payee with this name, ignoring case and spacing, created if it's new. A merged-away name comes back to life. */
export async function ensurePayee(db: Db, workspaceId: string, name: string): Promise<{ id: string; name: string }> {
  const normalized = normalizeDescription(name);
  const existing = await db.query<{ id: string; name: string }>(
    `UPDATE fin.payees SET is_archived = false, updated_at = now() WHERE workspace_id = $1 AND normalized_name = $2 RETURNING id, name`,
    [workspaceId, normalized],
  );
  if (existing.rows[0]) return existing.rows[0];
  const id = uuidv7();
  await db.query('INSERT INTO fin.payees (id, workspace_id, name, normalized_name) VALUES ($1, $2, $3, $4)', [id, workspaceId, name.trim(), normalized]);
  return { id, name: name.trim() };
}

/** Whether another payee in the workspace already has this name, ignoring case and spacing. */
export async function payeeNameTaken(db: Db, workspaceId: string, name: string, exceptId: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM fin.payees WHERE workspace_id = $1 AND normalized_name = $2 AND id <> $3', [workspaceId, normalizeDescription(name), exceptId]);
  return (result.rowCount ?? 0) > 0;
}

/** Remembers the category last used with a payee, unless the user has chosen one. */
export async function learnPayeeCategory(db: Db, workspaceId: string, payeeId: string, categoryId: string): Promise<void> {
  await db.query('UPDATE fin.payees SET default_category_id = $3 WHERE workspace_id = $1 AND id = $2 AND NOT default_is_explicit', [workspaceId, payeeId, categoryId]);
}

/** Returns the new version, or null if the payee changed since it was read. */
export async function updatePayee(
  db: Db,
  workspaceId: string,
  id: string,
  change: { name?: string | undefined; defaultCategoryId?: string | null | undefined; expectedVersion: number },
): Promise<number | null> {
  const result = await db.query<{ version: number }>(
    `UPDATE fin.payees
        SET name = COALESCE($3, name),
            normalized_name = COALESCE($4, normalized_name),
            default_category_id = CASE WHEN $5 THEN $6::uuid ELSE default_category_id END,
            default_is_explicit = CASE WHEN $5 THEN $6::uuid IS NOT NULL ELSE default_is_explicit END,
            version = version + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND version = $7
      RETURNING version`,
    [
      workspaceId,
      id,
      change.name?.trim() ?? null,
      change.name === undefined ? null : normalizeDescription(change.name),
      change.defaultCategoryId !== undefined,
      change.defaultCategoryId ?? null,
      change.expectedVersion,
    ],
  );
  return result.rows[0]?.version ?? null;
}

/** Moves every transaction to the other payee and archives this one (BR-05.6). Returns how many moved. */
export async function mergePayee(db: Db, workspaceId: string, fromId: string, intoId: string): Promise<number> {
  const moved = await db.query('UPDATE fin.transactions SET payee_id = $3 WHERE workspace_id = $1 AND payee_id = $2', [workspaceId, fromId, intoId]);
  await db.query('UPDATE fin.payees SET is_archived = true, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, fromId]);
  return moved.rowCount ?? 0;
}
