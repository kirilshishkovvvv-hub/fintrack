/**
 * The HTTP application as a single Fetch-standard handler: Request in, Response out.
 * The Next.js app mounts it in a catch-all route; tests call it directly.
 *
 * Every /api/v1 request: authenticate → resolve the user's workspace on the server →
 * validate → run the use case in one database transaction with row-level security.
 */
import { LedgerError } from '@fintrack/domain';
import {
  getWorkspace,
  idempotent,
  IdempotencyConflict,
  uuidv7,
  VersionConflict,
  withUser,
  withWorkspace,
  workspaceIdsForUser,
  type Db,
  type RequestContext,
} from '@fintrack/db';
import type pg from 'pg';
import { ZodError, type z } from 'zod';
import { FRESH_SESSION_SECONDS, SESSION_ABSOLUTE_SECONDS, type Auth } from './auth.ts';
import { buildExport } from './export.ts';
import { ApiError, json, problem, readJson, readOptionalJson, requestHash, requiredVersion } from './http.ts';
import * as catalog from './catalog.ts';
import * as reconciliation from './reconciliation.ts';
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
  /** When this session signed in; sensitive actions need it to be recent (BR-01.5). */
  signedInAt: number;
}

type Handler = (call: Call) => Promise<Response>;

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
  function idempotentWrite<S extends z.ZodType>(
    schema: S,
    run: (db: Db, context: RequestContext, input: z.infer<S>, call: Call) => Promise<unknown>,
    options: { status?: number; optionalBody?: boolean } = {},
  ): Handler {
    return async (call) => {
      const key = call.request.headers.get('idempotency-key');
      if (!key || key.length < 8 || key.length > 200) {
        throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header of 8 to 200 characters');
      }
      const body = options.optionalBody ? await readOptionalJson(call.request) : await readJson(call.request);
      const input = schema.parse(body);
      const hash = await requestHash(call.request.method, call.url.pathname, body);
      const result = await inWorkspace(
        call.userId,
        (db, context) =>
          idempotent(db, { userId: context.userId, workspaceId: context.workspaceId, key, requestHash: hash }, async () => ({
            status: options.status ?? 201,
            body: await run(db, context, input, call),
          })),
        true,
      );
      return json(result.status, result.body, result.replayed ? { 'idempotent-replayed': 'true' } : {});
    };
  }

  /** An action on an existing object, with no body (void, restore, unlock, archive): Idem, 200. */
  const ACTION = { status: 200, optionalBody: true };
  const statusAction = (action: 'void' | 'restore') =>
    idempotentWrite(schemas.emptyBody, (db, context, _input, call) => services.changeStatus(db, context, call.params.id!, action), ACTION);

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
    { method: 'POST', pattern: /^\/api\/v1\/accounts$/, handler: idempotentWrite(schemas.createAccountBody, services.createAccount) },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/categories$/,
      handler: async (call) => json(200, { items: await inWorkspace(call.userId, services.listCategories) }),
    },
    { method: 'POST', pattern: /^\/api\/v1\/categories$/, handler: idempotentWrite(schemas.createCategoryBody, services.createCategory) },
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
    {
      method: 'PATCH',
      pattern: new RegExp(`^/api/v1/transactions/${UUID}$`),
      handler: async (call) => {
        const version = requiredVersion(call.request);
        const input = schemas.editTransactionBody.parse(await readJson(call.request));
        const result = await inWorkspace(call.userId, (db, context) => services.editTransaction(db, context, call.params.id!, version, input), true);
        return json(200, result);
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/api/v1/transactions/${UUID}$`),
      handler: async (call) => {
        const version = requiredVersion(call.request);
        return json(200, await inWorkspace(call.userId, (db, context) => services.changeStatus(db, context, call.params.id!, 'trash', version), true));
      },
    },
    { method: 'POST', pattern: new RegExp(`^/api/v1/transactions/${UUID}/void$`), handler: statusAction('void') },
    { method: 'POST', pattern: new RegExp(`^/api/v1/transactions/${UUID}/restore$`), handler: statusAction('restore') },
    { method: 'POST', pattern: /^\/api\/v1\/transactions$/, handler: idempotentWrite(schemas.createTransactionBody, services.recordTransaction) },
    { method: 'POST', pattern: /^\/api\/v1\/transfers$/, handler: idempotentWrite(schemas.createTransferBody, services.recordTransfer) },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/undo/${UUID}$`),
      handler: idempotentWrite(schemas.emptyBody, (db, context, _input, call) => services.undo(db, context, call.params.id!), {
        status: 200,
        optionalBody: true,
      }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/reconciliations\/preview$/,
      handler: async (call) => {
        const input = schemas.reconciliationPreviewBody.parse(await readJson(call.request));
        return json(200, await inWorkspace(call.userId, (db, context) => reconciliation.previewReconciliation(db, context, input)));
      },
    },
    { method: 'POST', pattern: /^\/api\/v1\/reconciliations$/, handler: idempotentWrite(schemas.reconciliationBody, reconciliation.completeReconciliation) },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/reconciliations$/,
      handler: async (call) => {
        const query = schemas.reconciliationsQuery.parse(Object.fromEntries(call.url.searchParams));
        return json(200, { items: await inWorkspace(call.userId, (db, context) => reconciliation.listReconciliationsDto(db, context, query.accountId)) });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/reconciliations/${UUID}/unlock$`),
      handler: idempotentWrite(schemas.emptyBody, (db, context, _input, call) => reconciliation.unlock(db, context, call.params.id!), ACTION),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/accounts/${UUID}/balance-update$`),
      handler: idempotentWrite(schemas.balanceUpdateBody, (db, context, input, call) => reconciliation.updateBalance(db, context, call.params.id!, input), { status: 200 }),
    },
    ...(['archive', 'unarchive'] as const).flatMap((action): Route[] => [
      {
        method: 'POST',
        pattern: new RegExp(`^/api/v1/accounts/${UUID}/${action}$`),
        handler: idempotentWrite(schemas.emptyBody, (db, context, _input, call) => catalog.setAccountArchived(db, context, call.params.id!, action === 'archive'), ACTION),
      },
      {
        method: 'POST',
        pattern: new RegExp(`^/api/v1/categories/${UUID}/${action}$`),
        handler: idempotentWrite(schemas.emptyBody, (db, context, _input, call) => catalog.setCategoryArchived(db, context, call.params.id!, action === 'archive'), ACTION),
      },
    ]),
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/categories/${UUID}/merge$`),
      handler: idempotentWrite(schemas.mergeCategoryBody, (db, context, input, call) => catalog.mergeCategories(db, context, call.params.id!, input.intoId), { status: 200 }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/exports$/,
      handler: async (call) => {
        // Fresh (BR-01.5): a stolen or forgotten session alone can't take all the data away.
        if (Date.now() - call.signedInAt > FRESH_SESSION_SECONDS * 1000) {
          throw new ApiError(403, 'REAUTH_REQUIRED', 'Enter your password again to export your data');
        }
        const { filename, zip } = await inWorkspace(call.userId, buildExport, true);
        return new Response(new Uint8Array(zip), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/trash$/,
      handler: async (call) => json(200, { items: await inWorkspace(call.userId, services.listTrash) }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/summary$/,
      handler: async (call) => {
        const query = schemas.summaryQuery.parse(Object.fromEntries(call.url.searchParams));
        return json(200, await inWorkspace(call.userId, (db, context) => services.summary(db, context, query.at)));
      },
    },
  ];

  /**
   * The signed-in, verified user. `refreshed` holds the cookies Better Auth sets when it slides
   * the 30-minute idle expiry forward (AD-14); they must reach the browser, or its cookie would
   * still expire 30 minutes after sign-in, however active the user is.
   */
  async function authenticate(request: Request): Promise<{ userId: string; signedInAt: number; refreshed: string[] }> {
    const { headers, response: result } = await deps.auth.api.getSession({ headers: request.headers, returnHeaders: true });
    if (!result) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    // AC-01.1: an unverified account can't read or write any financial data.
    if (!result.user.emailVerified) throw new ApiError(401, 'UNAUTHENTICATED', 'Verify your email address first');
    // AD-14: an absolute lifetime of 30 days, whatever the activity.
    const age = Date.now() - new Date(result.session.createdAt).getTime();
    if (age > SESSION_ABSOLUTE_SECONDS * 1000) {
      await deps.auth.api.revokeSession({ headers: request.headers, body: { token: result.session.token } }).catch(() => undefined);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in again');
    }
    return { userId: result.user.id, signedInAt: new Date(result.session.createdAt).getTime(), refreshed: headers.getSetCookie() };
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
    const { userId, signedInAt, refreshed } = await authenticate(request);
    const match = route.pattern.exec(url.pathname);
    const params: Record<string, string> = match?.[1] ? { id: match[1] } : {};
    try {
      const response = await route.handler({ request, url, params, userId, signedInAt });
      for (const cookie of refreshed) response.headers.append('set-cookie', cookie);
      return response;
    } catch (error) {
      const response = toResponse(error, deps.reportError);
      for (const cookie of refreshed) response.headers.append('set-cookie', cookie);
      return response;
    }
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
  if (error instanceof VersionConflict) return problem(new ApiError(409, 'VERSION_CONFLICT', error.message));
  const code = (error as { code?: string } | null)?.code;
  // Raised by the database lock on reconciled transactions (migration 0005).
  if (code === 'FTL01') {
    return problem(new ApiError(409, 'LOCKED_RECONCILED', 'This transaction is reconciled. Unlock its reconciliation to change it'));
  }
  if (code === '23514') return problem(new ApiError(422, 'LEDGER_RULE', 'The database rejected the change because it breaks a rule'));
  if (code === '23503') return problem(new ApiError(422, 'INVALID_REFERENCE', 'A referenced item does not exist'));
  if (code === '23505') return problem(new ApiError(409, 'CONFLICT', 'That already exists'));
  const reference = crypto.randomUUID();
  report?.(error, reference);
  return problem(new ApiError(500, 'INTERNAL', `Something went wrong. Reference ${reference}`));
}
