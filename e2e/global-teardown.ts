/**
 * Stops the throwaway database and removes its folder. On Windows the runner ends the server
 * script abruptly, before the script can do this itself. Ending the main process is enough:
 * PostgreSQL's other processes exit when it's gone.
 */
import { readFileSync, rmSync } from 'node:fs';
import pg from 'pg';

export default async function globalTeardown(): Promise<void> {
  const { url } = JSON.parse(readFileSync('.pgdata/e2e-db.json', 'utf8')) as { url: string };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const pid = Number((await client.query<{ file: string }>(`SELECT pg_read_file('postmaster.pid') AS file`)).rows[0]!.file.split('\n')[0]);
  const folder = (await client.query<{ data_directory: string }>('SHOW data_directory')).rows[0]!.data_directory;
  await client.end();
  process.kill(pid);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
