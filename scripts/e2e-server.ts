/**
 * The server behind the browser tests: a throwaway database and the web app on port 3100. Security
 * emails go to the server log, so the output is kept in a file the tests read links from.
 * Next.js allows one dev server per folder, so stop `npm run dev:all` first.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase } from '../packages/db/src/test-database.ts';

export const E2E_PORT = 3100;

const root = fileURLToPath(new URL('..', import.meta.url));
const folder = path.join(root, '.pgdata');
mkdirSync(folder, { recursive: true });

const database = await startTestDatabase();
const { host, port, user, password, database: name } = database.connection;
const url = `postgres://${user}:${encodeURIComponent(String(password))}@${host}:${port}/${name}`;
writeFileSync(path.join(folder, 'e2e-db.json'), JSON.stringify({ url }));
const log = createWriteStream(path.join(folder, 'e2e-server.log'));

const server = spawn(`npx next dev --port ${E2E_PORT}`, {
  cwd: path.join(root, 'apps', 'web'),
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: url,
    AUTH_SECRET: randomBytes(32).toString('base64url'),
    APP_ORIGIN: `http://localhost:${E2E_PORT}`,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
  },
});
server.stdout.pipe(log);
server.stderr.pipe(log);
server.stdout.pipe(process.stdout);

const stop = async () => {
  server.kill();
  await database.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', stop);
