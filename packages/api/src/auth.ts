/**
 * Authentication with Better Auth (AD-04), configured to FR-01 and Stage 2 §8.1–8.2.
 * Users, sessions and credentials live in our own database, in the `auth` schema.
 */
import { passkey } from '@better-auth/passkey';
import { hash, verify, type Options as Argon2Options } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { haveIBeenPwned, twoFactor } from 'better-auth/plugins';
import type pg from 'pg';
import { recordAuditEvent, recordConsents, withUser } from '@fintrack/db';
import { createLoginThrottle } from './login-throttle.ts';

/** OWASP minimum for Argon2id: 19 MiB memory, 2 iterations, parallelism 1 (AD-04). */
// `Algorithm` is a const enum, which isolated modules can't import; 2 is Algorithm.Argon2id.
const ARGON2ID: Argon2Options = {
  algorithm: 2 as NonNullable<Argon2Options['algorithm']>,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * BR-01.5 and AD-14: a session ends after 30 idle minutes, or 14 days with "keep me signed in",
 * and in any case after 30 days. Better Auth has one expiry for all sessions, so it gets the longer
 * one and createApp enforces the idle limit of each session (T-38).
 */
export const SESSION_IDLE_SECONDS = 30 * 60;
export const SESSION_KEEP_IDLE_SECONDS = 14 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
/** BR-01.5: sensitive actions need a sign-in within the last 10 minutes. */
export const FRESH_SESSION_SECONDS = 10 * 60;

export interface OutgoingEmail {
  to: string;
  kind: 'verify-email' | 'reset-password' | 'deletion-requested' | 'passkey-added' | 'passkey-removed';
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
  /** Stores sign-ins and failed sign-ins in the audit log (FR-19). */
  recordSecurityEvent: (userId: string, type: 'auth.login' | 'auth.login_failed' | 'auth.passkey_added' | 'auth.passkey_removed') => Promise<void>;
}

export function createAuth(deps: AuthDependencies) {
  const throttle = createLoginThrottle(deps.pool, deps.secret);
  const emailOf = (body: unknown) => String((body as { email?: unknown } | null)?.email ?? '');
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
      expiresIn: SESSION_KEEP_IDLE_SECONDS,
      updateAge: 5 * 60,
      freshAge: FRESH_SESSION_SECONDS,
      // No cookie cache: a revoked session must stop working on its next request (AC-01.4).
      cookieCache: { enabled: false },
      additionalFields: {
        keepSignedIn: { type: 'boolean', required: false, input: false },
        lastActiveAt: { type: 'date', required: false, input: false },
      },
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
        '/passkey/verify-authentication': { window: 15 * 60, max: 10 },
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
        // BR-01.5: like adding one, removing a passkey needs a recent sign-in. Better Auth checks the adding.
        if (ctx.path === '/passkey/delete-passkey') {
          const session = await getSessionFromCtx(ctx);
          if (session && Date.now() - new Date(session.session.createdAt).getTime() > FRESH_SESSION_SECONDS * 1000) {
            throw new APIError('FORBIDDEN', { message: 'Confirm it is you first', code: 'REAUTH_REQUIRED' });
          }
        }
        if (ctx.path === '/sign-up/email' && !readConsents(ctx.body)) {
          throw new APIError('BAD_REQUEST', { message: 'Accept the terms and privacy notice, and confirm you are 18 or older' });
        }
        // BR-01.3: the same answer whether or not the address exists or the password is right.
        if (ctx.path === '/sign-in/email') {
          const wait = await throttle.waitSeconds(emailOf(ctx.body));
          if (wait > 0) {
            throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many attempts. Wait and try again' }, { 'retry-after': String(wait) });
          }
          // Better Auth treats a missing rememberMe as true; here staying signed in must be asked for (AD-14).
          return { context: { body: { ...ctx.body, rememberMe: (ctx.body as { rememberMe?: unknown } | undefined)?.rememberMe === true } } };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (ctx.path === '/passkey/verify-authentication' && ctx.context.newSession) {
          await deps.recordSecurityEvent(ctx.context.newSession.user.id, 'auth.login');
        }
        // A new way into the account gets a record and a notice, so a stolen session can't add one quietly.
        if ((ctx.path === '/passkey/verify-registration' || ctx.path === '/passkey/delete-passkey') && !(returned instanceof APIError)) {
          const session = await getSessionFromCtx(ctx);
          if (session) {
            const added = ctx.path === '/passkey/verify-registration';
            await deps.recordSecurityEvent(session.user.id, added ? 'auth.passkey_added' : 'auth.passkey_removed');
            await deps.sendEmail({ to: session.user.email, kind: added ? 'passkey-added' : 'passkey-removed', url: `${deps.baseURL}/settings/passkeys` });
          }
        }
        if (ctx.path !== '/sign-in/email') return;
        const email = emailOf(ctx.body);
        if (returned instanceof APIError && returned.statusCode === 401) {
          await throttle.recordFailure(email);
          const user = await deps.pool.query<{ id: string }>('SELECT id FROM auth."user" WHERE lower(email) = lower($1)', [email.trim()]);
          if (user.rows[0]) await deps.recordSecurityEvent(user.rows[0].id, 'auth.login_failed');
        } else if (ctx.context.newSession) {
          await throttle.clear(email);
          await deps.recordSecurityEvent(ctx.context.newSession.user.id, 'auth.login');
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // "Keep me signed in" is an explicit choice, never the default (AD-14). Without it the cookie
          // lasts until the browser closes and Better Auth doesn't slide the expiry (it would stop at
          // 1 day), so the row gets the absolute limit and createApp enforces the idle limit.
          before: async (session, context) => {
            const keepSignedIn = (context?.body as { rememberMe?: unknown } | undefined)?.rememberMe === true;
            const expiresAt = keepSignedIn ? session.expiresAt : new Date(Date.now() + SESSION_ABSOLUTE_SECONDS * 1000);
            return { data: { ...session, expiresAt, keepSignedIn, lastActiveAt: new Date() } };
          },
        },
      },
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
      passkey({
        rpID: new URL(deps.baseURL).hostname,
        rpName: 'Fintrack',
        origin: new URL(deps.baseURL).origin,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        // The plugin itself doesn't insist on the face, finger or PIN check. A passkey stands in for
        // the password, so a key that was only tapped must not be enough, here or at sign-in.
        registration: {
          afterVerification: async ({ verification }) => {
            if (!verification.registrationInfo?.userVerified) {
              throw new APIError('BAD_REQUEST', { message: 'This authenticator cannot check who is using it' });
            }
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) {
              throw new APIError('UNAUTHORIZED', { message: 'The device did not check who is using it' });
            }
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Stores a security event in the audit log, under the user's own context. It has no workspace. */
export function createSecurityEventRecorder(pool: pg.Pool): AuthDependencies['recordSecurityEvent'] {
  return (userId, type) => withUser(pool, userId, (db) => recordAuditEvent(db, { workspaceId: null, userId, type }));
}

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
