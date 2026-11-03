/**
 * The server-side application, created once per process. Configuration comes from the
 * environment and is validated at startup; the server refuses to start without it
 * (Stage 2 §13.1).
 */
import pg from 'pg';
import { z } from 'zod';
import { createApp, createAuth, createConsentRecorder, type Auth, type OutgoingEmail } from '@fintrack/api';

const env = z
  .object({
    DATABASE_URL: z.string().startsWith('postgres'),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    APP_ORIGIN: z.url(),
    EMAIL_MODE: z.enum(['log']).default('log'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  })
  .parse(process.env);

interface ServerApp {
  handle: (request: Request) => Promise<Response>;
  auth: Auth;
}

/** Development only: security emails are printed to the server log instead of being sent. */
async function logEmail(email: OutgoingEmail): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('No email provider is configured for production yet (AD-12: Scaleway)');
  }
  console.info(`[dev-email] ${email.kind} for ${email.to}: ${email.url}`);
}

function build(): ServerApp {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  const authPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, options: '-c search_path=auth' });
  const auth = createAuth({
    pool: authPool,
    baseURL: env.APP_ORIGIN,
    secret: env.AUTH_SECRET,
    sendEmail: logEmail,
    checkBreachedPasswords: env.NODE_ENV === 'production',
    secureCookies: env.APP_ORIGIN.startsWith('https://'),
    recordConsents: createConsentRecorder(pool),
  });
  const handle = createApp({
    pool,
    auth,
    allowedOrigin: new URL(env.APP_ORIGIN).origin,
    reportError: (error, reference) => console.error(`[error ${reference}]`, error),
  });
  return { handle, auth };
}

const globalForApp = globalThis as unknown as { fintrackServerApp?: ServerApp };

export function serverApp(): ServerApp {
  globalForApp.fintrackServerApp ??= build();
  return globalForApp.fintrackServerApp;
}
