/**
 * A throwaway PostgreSQL cluster for tests and local development (no system install).
 * Each call starts a fresh cluster in a temporary directory, on a free port, and
 * applies all migrations. The password is random and never leaves this process.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from './migrate.ts';

export interface TestDatabase {
  pool: pg.Pool;
  /** Connection settings for opening further pools (for example the auth pool). */
  connection: pg.PoolConfig;
  stop(): Promise<void>;
}

/**
 * PostgreSQL 18 starts separate I/O worker processes by default. On Windows they can outlive a
 * stopped cluster and block the next start (T-25), so local clusters use synchronous I/O.
 */
export const NO_IO_WORKERS = ['-c', 'io_method=sync'];

/**
 * Local clusters are UTF-8 with the C locale, whatever the machine's language: otherwise initdb
 * picks the system code page (WIN1251 on a Bulgarian Windows) and non-Cyrillic text can't be stored.
 */
export const UTF8_CLUSTER = ['--encoding=UTF8', '--locale=C'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const databaseDir = await mkdtemp(path.join(tmpdir(), 'fintrack-pg-'));
  const port = await freePort();
  const password = randomBytes(18).toString('base64url');
  const cluster = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password,
    persistent: false,
    initdbFlags: UTF8_CLUSTER,
    postgresFlags: NO_IO_WORKERS,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase('fintrack_test');

  const connection: pg.PoolConfig = {
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password,
    database: 'fintrack_test',
    max: 10,
  };
  const pool = new pg.Pool(connection);
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }

  return {
    pool,
    connection,
    async stop() {
      await pool.end();
      await cluster.stop();
      await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
