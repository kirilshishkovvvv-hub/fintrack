/**
 * Local development: starts a persistent embedded PostgreSQL in .pgdata (gitignored),
 * applies migrations, then runs the Next.js dev server with the right environment.
 * Secrets are generated once on this machine and stay in .pgdata; nothing is committed.
 * Run with: npm run dev:all
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '../packages/db/src/migrate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataRoot = path.join(root, '.pgdata');
const clusterDir = path.join(dataRoot, 'cluster');
const secretsFile = path.join(dataRoot, 'dev-secrets.json');
const PORT = 54329;
const DATABASE = 'fintrack_dev';

interface DevSecrets {
  dbPassword: string;
  authSecret: string;
}

await mkdir(dataRoot, { recursive: true });
const secrets: DevSecrets = existsSync(secretsFile)
  ? JSON.parse(await readFile(secretsFile, 'utf8'))
  : { dbPassword: randomBytes(18).toString('base64url'), authSecret: randomBytes(32).toString('base64url') };
await writeFile(secretsFile, JSON.stringify(secrets, null, 2));

const fresh = !existsSync(path.join(clusterDir, 'PG_VERSION'));
const cluster = new EmbeddedPostgres({
  databaseDir: clusterDir,
  port: PORT,
  user: 'postgres',
  password: secrets.dbPassword,
  persistent: true,
  onLog: () => undefined,
  onError: (message) => console.error(`[dev] postgres: ${String(message).trim()}`),
});
try {
  if (fresh) await cluster.initialise();
  await cluster.start();
} catch (error) {
  console.error('[dev] PostgreSQL did not start. Is another dev server still running?', error);
  process.exit(1);
}

const adminUrl = `postgres://postgres:${encodeURIComponent(secrets.dbPassword)}@127.0.0.1:${PORT}/postgres`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DATABASE}`);
await admin.end();

const databaseUrl = `postgres://postgres:${encodeURIComponent(secrets.dbPassword)}@127.0.0.1:${PORT}/${DATABASE}`;
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
const ran = await migrate(client);
await client.end();
console.info(`[dev] PostgreSQL on port ${PORT}${ran.length ? `, applied ${ran.join(', ')}` : ', migrations up to date'}`);

const next = spawn('npm run dev -w @fintrack/web', {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: secrets.authSecret,
    APP_ORIGIN: 'http://localhost:3000',
    NODE_ENV: 'development',
    // No usage data leaves the machine (AD-21).
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

const shutdown = async () => {
  next.kill();
  await cluster.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
next.on('exit', shutdown);
