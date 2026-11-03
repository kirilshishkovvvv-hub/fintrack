/**
 * Forward-only SQL migrations (Stage 2 §11.1). Each file runs once, in name order,
 * inside its own database transaction, as the migration (owner) role.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(client: pg.Client | pg.PoolClient, directory = MIGRATIONS_DIR): Promise<string[]> {
  // Names, descriptions and memos can be in any of the planned languages (MKT-2), so the
  // database must store all of Unicode. A cluster created in a local code page would not.
  const encoding = (await client.query<{ encoding: string }>("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()")).rows[0]?.encoding;
  if (encoding !== 'UTF8') {
    throw new Error(`The database uses ${encoding} encoding; it must be UTF8. Create it with ENCODING 'UTF8' TEMPLATE template0`);
  }
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS ops;
    CREATE TABLE IF NOT EXISTS ops.schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const applied = new Set(
    (await client.query<{ version: string }>('SELECT version FROM ops.schema_migrations')).rows.map((row) => row.version),
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(directory, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO ops.schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return ran;
}
