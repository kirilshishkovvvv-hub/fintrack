/**
 * The HTTP application as a single Fetch-standard handler: Request in, Response out.
 * The Next.js app mounts it in a catch-all route; tests call it directly.
 *
 * Every /api/v1 request: authenticate → resolve the user's workspace on the server →
 * validate → run the use case in one database transaction with row-level security.
 */
import { LedgerError } from '@fintrack/domain';
import { idempotent, IdempotencyConflict, uuidv7, withUser, withWorkspace, workspaceIdsForUser, getWorkspace, type Db, type RequestContext } from '@fintrack/db';
import type pg from 'pg';
import { ZodError, type z } from 'zod';
import { SESSION_ABSOLUTE_SECONDS, type Auth } from './auth.ts';
import { ApiError, json, problem, readJson, requestHash } from './http.ts';
import * as schemas from './schemas.ts';
import * as services from './services.ts';

export interface AppDependencies {
  pool: pg.Pool;
  auth: Auth;
  /** The app's own origin, e.g. https://app.example.com. State-changing requests must come from it. */
  allowedOrigin: string;
  /** Reports unexpected errors (Sentry in production). Receives no request bodies. */
  reportError?: (error: unknown, reference: string) => void;
}

interface Call {
  request: Request;
  url: URL;
  params: Record<string, string>;
  userId: string;
}

type Handler = (call: Call) => Promise<Response>;

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: Handler;
}

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

export function createApp(deps: AppDependencies) {
  /** Runs work in the caller's workspace, which is always resolved on the server (Stage 2 §8.3). */
  async function inWorkspace<T>(userId: string, work: (db: Db, context: RequestContext) => Promise<T>, write = false): Promise<T> {
    const [workspaceId] = await withUser(deps.pool, userId, (db) => workspaceIdsForUser(db, userId));
    if (!workspaceId) throw new ApiError(409, 'NO_WORKSPACE', 'Create your workspace first');
    const context = { workspaceId, userId };
    return withWorkspace(deps.pool, context, (db) => work(db, context), { write });
  }

  /** A state-changing call with a required Idempotency-Key (Stage 2 §7.5). */
  function idempotentCreate<S extends z.ZodType>(schema: S, run: (db: Db, context: RequestContext, input: z.infer<S>) => Promise<unknown>): Handler {
    return async (call) => {
      const key = call.request.headers.get('idempotency-key');
      if (!key || key.length < 8 || key.length > 200) {
        throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header of 8 to 200 characters');
      }
      const body = await readJson(call.request);
      const input = schema.parse(body);
      const hash = await requestHash(call.request.method, call.url.pathname, body);
      const result = await inWorkspace(
        call.userId,
        (db, context) =>
          idempotent(db, { userId: context.userId, workspaceId: context.workspaceId, key, requestHash: hash }, async () => ({
            status: 201,
            body: await run(db, context, input),
          })),
        true,
      );
      return json(result.status, result.body, result.replayed ? { 'idempotent-replayed': 'true' } : {});
    };
  }

  const routes: Route[] = [
    {
      method: 'POST',
      pattern: /^\/api\/v1\/workspaces$/,
      handler: async (call) => {
        const input = schemas.createWorkspaceBody.parse(await readJson(call.request));
        const context = { workspaceId: uuidv7(), userId: call.userId };
        const outcome = await withWorkspace(deps.pool, context, (db) => services.createOrGetWorkspace(db, context, input), { write: true });
        const workspace = await withWorkspace(deps.pool, { workspaceId: outcome.workspaceId, userId: call.userId }, (db) => getWorkspace(db, outcome.workspaceId));
        return json(outcome.created ? 201 : 200, services.workspaceDto(workspace));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/workspace$/,
      handler: async (call) => json(200, services.workspaceDto(await inWorkspace(call.userId, (db, context) => getWorkspace(db, context.workspaceId)))),
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/accounts$/,
      handler: async (call) => json(200, { items: await inWorkspace(call.userId, services.listAccounts) }),
    },
    { method: 'POST', pattern: /^\/api\/v1\/accounts$/, handler: idempotentCreate(schemas.createAccountBody, services.createAccount) },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/categories$/,
      handler: async (call) => json(200, { items: await inWorkspace(call.userId, services.listCategories) }),
    },
    { method: 'POST', pattern: /^\/api\/v1\/categories$/, handler: idempotentCreate(schemas.createCategoryBody, services.createCategory) },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/transactions$/,
      handler: async (call) => {
        const period = schemas.periodQuery.parse(Object.fromEntries(call.url.searchParams));
        return json(200, { items: await inWorkspace(call.userId, (db, context) => services.listTransactions(db, context, period)) });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/v1/transactions/${UUID}$`),
      handler: async (call) => json(200, await inWorkspace(call.userId, (db, context) => services.getTransaction(db, context, call.params.id!))),
    },
    { method: 'POST', pattern: /^\/api\/v1\/transactions$/, handler: idempotentCreate(schemas.createTransactionBody, services.recordTransaction) },
    { method: 'POST', pattern: /^\/api\/v1\/transfers$/, handler: idempotentCreate(schemas.createTransferBody, services.recordTransfer) },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/summary$/,
      handler: async (call) => {
        const query = schemas.summaryQuery.parse(Object.fromEntries(call.url.searchParams));
        return json(200, await inWorkspace(call.userId, (db, context) => services.summary(db, context, query.at)));
      },
    },
  ];

  async function authenticate(request: Request): Promise<string> {
    const result = await deps.auth.api.getSession({ headers: request.headers });
    if (!result) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    // AC-01.1: an unverified account can't read or write any financial data.
    if (!result.user.emailVerified) throw new ApiError(401, 'UNAUTHENTICATED', 'Verify your email address first');
    // AD-14: an absolute lifetime of 30 days, whatever the activity.
    const age = Date.now() - new Date(result.session.createdAt).getTime();
    if (age > SESSION_ABSOLUTE_SECONDS * 1000) {
      await deps.auth.api.revokeSession({ headers: request.headers, body: { token: result.session.token } }).catch(() => undefined);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in again');
    }
    return result.user.id;
  }

  async function dispatch(request: Request, url: URL): Promise<Response> {
    const matching = routes.filter((route) => route.pattern.test(url.pathname));
    if (matching.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    const route = matching.find((candidate) => candidate.method === request.method);
    if (!route) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');

    // CSRF defence (Stage 2 §8.4): state-changing requests must come from our own origin.
    if (request.method !== 'GET' && request.headers.get('origin') !== deps.allowedOrigin) {
      throw new ApiError(403, 'FORBIDDEN_ORIGIN', 'Requests must come from the app');
    }
    const userId = await authenticate(request);
    const match = route.pattern.exec(url.pathname);
    const params: Record<string, string> = match?.[1] ? { id: match[1] } : {};
    return route.handler({ request, url, params, userId });
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/auth/')) return deps.auth.handler(request);
    try {
      return await dispatch(request, url);
    } catch (error) {
      return toResponse(error, deps.reportError);
    }
  };
}

function toResponse(error: unknown, report?: (error: unknown, reference: string) => void): Response {
  if (error instanceof ApiError) return problem(error);
  if (error instanceof ZodError) {
    return problem(new ApiError(422, 'VALIDATION_FAILED', 'The request is not valid', error.issues.map((issue) => ({ path: issue.path, message: issue.message }))));
  }
  if (error instanceof LedgerError) {
    return problem(new ApiError(422, 'LEDGER_RULE', 'The transaction breaks a ledger rule', error.violations));
  }
  if (error instanceof IdempotencyConflict) return problem(new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', error.message));
  const code = (error as { code?: string } | null)?.code;
  if (code === '23514') return problem(new ApiError(422, 'LEDGER_RULE', 'The database rejected the change because it breaks a rule'));
  if (code === '23503') return problem(new ApiError(422, 'INVALID_REFERENCE', 'A referenced item does not exist'));
  if (code === '23505') return problem(new ApiError(409, 'CONFLICT', 'That already exists'));
  const reference = crypto.randomUUID();
  report?.(error, reference);
  return problem(new ApiError(500, 'INTERNAL', `Something went wrong. Reference ${reference}`));
}
