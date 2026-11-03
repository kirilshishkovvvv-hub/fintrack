import type { Db } from './context.ts';
import { uuidv7 } from './ids.ts';

export type ConsentDocument = 'terms' | 'privacy' | 'age_18' | 'marketing';

/** Records consents for the current user (needs app.user_id; see withUser). */
export async function recordConsents(
  db: Db,
  userId: string,
  consents: { document: ConsentDocument; version: string; accepted: boolean }[],
): Promise<void> {
  for (const consent of consents) {
    await db.query(
      'INSERT INTO fin.consent_records (id, user_id, document, version, accepted) VALUES ($1, $2, $3, $4, $5)',
      [uuidv7(), userId, consent.document, consent.version, consent.accepted],
    );
  }
}

/** The latest decision per document for the current user. */
export async function currentConsents(db: Db, userId: string): Promise<Record<string, { version: string; accepted: boolean }>> {
  const result = await db.query<{ document: string; version: string; accepted: boolean }>(
    `SELECT DISTINCT ON (document) document, version, accepted
       FROM fin.consent_records WHERE user_id = $1
      ORDER BY document, recorded_at DESC, id DESC`,
    [userId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.document, { version: row.version, accepted: row.accepted }]));
}
