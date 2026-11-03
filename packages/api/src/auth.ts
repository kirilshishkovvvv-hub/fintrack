/**
 * Authentication with Better Auth (AD-04), configured to FR-01 and Stage 2 §8.1–8.2.
 * Users, sessions and credentials live in our own database, in the `auth` schema.
 */
import { hash, verify, type Options as Argon2Options } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { haveIBeenPwned, twoFactor } from 'better-auth/plugins';
import type pg from 'pg';
import { recordConsents, withUser } from '@fintrack/db';

/** OWASP minimum for Argon2id: 19 MiB memory, 2 iterations, parallelism 1 (AD-04). */
// `Algorithm` is a const enum, which isolated modules can't import; 2 is Algorithm.Argon2id.
const ARGON2ID: Argon2Options = {
  algorithm: 2 as NonNullable<Argon2Options['algorithm']>,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** BR-01.5 and AD-14: a session ends after 30 idle minutes, and in any case after 30 days. */
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
/** BR-01.5: sensitive actions need a sign-in within the last 10 minutes. */
export const FRESH_SESSION_SECONDS = 10 * 60;

export interface OutgoingEmail {
  to: string;
  kind: 'verify-email' | 'reset-password';
  url: string;
}

/**
 * Current versions of the documents a user accepts at sign-up (Annex L items 1, 2, 6, 17).
 * Bump a version when the document changes; the lawyer-reviewed texts replace the drafts.
 */
export const LEGAL_VERSIONS = { terms: 'draft-2026-11', privacy: 'draft-2026-11', age_18: '1' } as const;

export interface SignUpConsents {
  terms: true;
  privacy: true;
  age18: true;
  marketing?: boolean;
}

function readConsents(body: unknown): SignUpConsents | null {
  const consents = (body as { consents?: Record<string, unknown> } | null)?.consents;
  if (!consents || consents.terms !== true || consents.privacy !== true || consents.age18 !== true) return null;
  return {
    terms: true,
    privacy: true,
    age18: true,
    ...(typeof consents.marketing === 'boolean' ? { marketing: consents.marketing } : {}),
  };
}

export interface AuthDependencies {
  /** A pool whose connections use `search_path=auth`. */
  pool: pg.Pool;
  baseURL: string;
  /** At least 32 random characters, from the environment; never committed. */
  secret: string;
  sendEmail: (email: OutgoingEmail) => Promise<void>;
  /** The k-anonymity Pwned Passwords check (AD-19). Off only in automated tests. */
  checkBreachedPasswords: boolean;
  /** Secure cookies everywhere except local development over plain http. */
  secureCookies: boolean;
  /** Stores the sign-up consents of a newly created user (Annex L item 6). */
  recordConsents: (userId: string, consents: SignUpConsents) => Promise<void>;
}

export function createAuth(deps: AuthDependencies) {
  return betterAuth({
    appName: 'Fintrack',
    baseURL: deps.baseURL,
    basePath: '/api/auth',
    secret: deps.secret,
    database: deps.pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      password: {
        hash: (password) => hash(password, ARGON2ID),
        verify: ({ hash: stored, password }) => verify(stored, password),
      },
      sendResetPassword: async ({ user, url }) => deps.sendEmail({ to: user.email, kind: 'reset-password', url }),
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => deps.sendEmail({ to: user.email, kind: 'verify-email', url }),
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: 5 * 60,
      freshAge: FRESH_SESSION_SECONDS,
      // No cookie cache: a revoked session must stop working on its next request (AC-01.4).
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 15 * 60, max: 5 },
        '/sign-up/email': { window: 60 * 60, max: 10 },
        '/request-password-reset': { window: 60 * 60, max: 5 },
        '/two-factor/*': { window: 15 * 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: deps.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: deps.secureCookies },
    },
    hooks: {
      // Sign-up needs the terms, the privacy notice and the 18+ confirmation, never pre-ticked
      // (Annex L items 6 and 17). Checked before anything else, so the answer reveals nothing
      // about whether the email is registered (AC-01.2).
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' && !readConsents(ctx.body)) {
          throw new APIError('BAD_REQUEST', { message: 'Accept the terms and privacy notice, and confirm you are 18 or older' });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => {
            const consents = readConsents(context?.body);
            if (consents) await deps.recordConsents(user.id, consents);
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: 'Fintrack' }),
      haveIBeenPwned({ enabled: deps.checkBreachedPasswords }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Stores sign-up consents in fin.consent_records, under the new user's own context. */
export function createConsentRecorder(pool: pg.Pool): AuthDependencies['recordConsents'] {
  return (userId, consents) =>
    withUser(pool, userId, (db) =>
      recordConsents(db, userId, [
        { document: 'terms', version: LEGAL_VERSIONS.terms, accepted: consents.terms },
        { document: 'privacy', version: LEGAL_VERSIONS.privacy, accepted: consents.privacy },
        { document: 'age_18', version: LEGAL_VERSIONS.age_18, accepted: consents.age18 },
        { document: 'marketing', version: '1', accepted: consents.marketing ?? false },
      ]),
    );
}
