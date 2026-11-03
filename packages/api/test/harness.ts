/**
 * Test harness: a real PostgreSQL (embedded), real Better Auth, and the API handler,
 * called through standard Request objects exactly as the web server will call it.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { startTestDatabase, type TestDatabase } from '../../db/src/test-database.ts';
import { createApp, createAuth, type OutgoingEmail } from '../src/index.ts';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct horse battery staple';

export interface Harness {
  database: TestDatabase;
  handle: (request: Request) => Promise<Response>;
  emails: OutgoingEmail[];
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const database = await startTestDatabase();
  const authPool = new pg.Pool({ ...database.connection, options: '-c search_path=auth' });
  const emails: OutgoingEmail[] = [];
  const auth = createAuth({
    pool: authPool,
    baseURL: ORIGIN,
    secret: randomBytes(32).toString('base64url'),
    sendEmail: async (email) => {
      emails.push(email);
    },
    checkBreachedPasswords: false,
    secureCookies: false,
  });
  const handle = createApp({ pool: database.pool, auth, allowedOrigin: ORIGIN });
  return {
    database,
    handle,
    emails,
    async stop() {
      await authPool.end();
      await database.stop();
    },
  };
}

let ipCounter = 0;

/** A browser-like client with its own cookie jar and source address. */
export class Client {
  cookie = '';
  readonly ip = `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  constructor(private readonly harness: Harness) {}

  async call(method: string, path: string, options: { body?: unknown; key?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, ...options.headers };
    if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
    if (this.cookie) headers.cookie = this.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.key) headers['idempotency-key'] = options.key;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const response = await this.harness.handle(new Request(`${ORIGIN}${path}`, init));
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) this.storeCookies(setCookies);
    const text = await response.text();
    const body = text ? (JSON.parse(text) as any) : null;
    return { status: response.status, body, headers: response.headers };
  }

  private storeCookies(setCookies: string[]) {
    const jar = new Map(this.cookie ? this.cookie.split('; ').map((pair) => pair.split('=') as [string, string]) : []);
    for (const header of setCookies) {
      const [pair] = header.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (!value || /max-age=0/i.test(header)) jar.delete(name!);
      else jar.set(name!, value);
    }
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** Signs a new user up, follows the verification link, and signs them in. */
export async function verifiedUser(harness: Harness, email: string): Promise<Client> {
  const client = new Client(harness);
  const signUp = await client.call('POST', '/api/auth/sign-up/email', { body: { email, password: PASSWORD, name: email.split('@')[0] } });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status} ${JSON.stringify(signUp.body)}`);
  const verification = [...harness.emails].reverse().find((sent) => sent.to === email && sent.kind === 'verify-email');
  if (!verification) throw new Error('no verification email was sent');
  const link = new URL(verification.url);
  await client.call('GET', `${link.pathname}${link.search}`);
  const signIn = await client.call('POST', '/api/auth/sign-in/email', { body: { email, password: PASSWORD } });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status} ${JSON.stringify(signIn.body)}`);
  return client;
}

export function key(): string {
  return `test-${randomBytes(12).toString('hex')}`;
}
