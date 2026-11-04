/**
 * Per-account login throttling (BR-01.3, AC-01.5): from the 5th failure within 15 minutes, each
 * further attempt must wait, 30 seconds at first and doubling up to 15 minutes. It's a delay and
 * not a permanent lock, so nobody can shut a person out of their account for long.
 * The per-source limit is Better Auth's rate limiter (T-11).
 */
import { createHmac } from 'node:crypto';
import type pg from 'pg';

const WINDOW_MINUTES = 15;
const FIRST_DELAY_FAILURES = 5;
const FIRST_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 15 * 60;

export function delaySeconds(failures: number): number {
  if (failures < FIRST_DELAY_FAILURES) return 0;
  return Math.min(MAX_DELAY_SECONDS, FIRST_DELAY_SECONDS * 2 ** (failures - FIRST_DELAY_FAILURES));
}

export function createLoginThrottle(pool: pg.Pool, secret: string) {
  const keyOf = (email: string) => createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex');
  return {
    /** Seconds this address must still wait, or 0. */
    async waitSeconds(email: string): Promise<number> {
      const result = await pool.query<{ seconds: number }>(
        'SELECT ceil(extract(epoch FROM locked_until - now()))::int AS seconds FROM auth.login_throttle WHERE key = $1 AND locked_until > now()',
        [keyOf(email)],
      );
      return result.rows[0]?.seconds ?? 0;
    },
    async recordFailure(email: string): Promise<void> {
      const key = keyOf(email);
      const result = await pool.query<{ failures: number }>(
        `INSERT INTO auth.login_throttle AS t (key, failures, first_failure_at) VALUES ($1, 1, now())
         ON CONFLICT (key) DO UPDATE SET
           failures = CASE WHEN t.first_failure_at < now() - make_interval(mins => $2) THEN 1 ELSE t.failures + 1 END,
           first_failure_at = CASE WHEN t.first_failure_at < now() - make_interval(mins => $2) THEN now() ELSE t.first_failure_at END
         RETURNING failures`,
        [key, WINDOW_MINUTES],
      );
      const delay = delaySeconds(result.rows[0]!.failures);
      await pool.query('UPDATE auth.login_throttle SET locked_until = CASE WHEN $2 > 0 THEN now() + make_interval(secs => $2) END WHERE key = $1', [key, delay]);
    },
    async clear(email: string): Promise<void> {
      await pool.query('DELETE FROM auth.login_throttle WHERE key = $1', [keyOf(email)]);
    },
  };
}
