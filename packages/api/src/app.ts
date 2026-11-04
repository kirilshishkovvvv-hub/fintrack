/**
 * The HTTP application as a single Fetch-standard handler: Request in, Response out.
 * The Next.js app mounts it in a catch-all route; tests call it directly.
 *
 * Every /api/v1 request: authenticate → resolve the user's workspace on the server →
 * validate → run the use case in one database transaction with row-level security.
 */
import { IMPORT_MAX_BYTES, LedgerError } from '@fintrack/domain';
import {
  getWorkspace,
  idempotent,
  listAuditEvents,
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
import { FRESH_SESSION_SECONDS, SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS, SESSION_KEEP_IDLE_SECONDS, type Auth, type OutgoingEmail } from './auth.ts';
import * as deletion from './deletion.ts';
import * as imports from './imports.ts';
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
  /** Sends security emails, here the notice of a deletion request. */
  sendEmail?: (email: OutgoingEmail) => Promise<void>;
}

interface Call {
  request: Request;
  url: URL;
  params: Record<string, string>;
  userId: string;
  email: string;
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
  async function inWorkspace<T>(
    userId: string,
    work: (db: Db, context: RequestContext) => Promise<T>,
    write = false,
    allowPendingDeletion = false,
  ): Promise<T> {
    const [workspaceId] = await withUser(deps.pool, userId, (db) => workspaceIdsForUser(db, userId));
    if (!workspaceId) throw new ApiError(409, 'NO_WORKSPACE', 'Create your workspace first');
    const context = { workspaceId, userId };
    return withWorkspace(
      deps.pool,
      context,
      async (db) => {
        // §8.6: during the cancel window, only cancelling, exporting and reading the status work.
        if (!allowPendingDeletion && (await getWorkspace(db, workspaceId)).status !== 'active') {
          throw new ApiError(409, 'DELETION_PENDING', 'This account is scheduled for deletion');
        }
        return work(db, context);
      },
      { write },
    );
  }

  /** BR-01.5, AC-01.6: sensitive actions need a sign-in within the last 10 minutes. */
  function requireFresh(call: Call) {
    if (Date.now() - call.signedInAt > FRESH_SESSION_SECONDS * 1000) {
      throw new ApiError(403, 'REAUTH_REQUIRED', 'Enter your password again to continue');
    }
  }

  /** A state-changing call with a required Idempotency-Key (Stage 2 §7.5). */
  function idempotentWrite<S extends z.ZodType>(
    schema: S,
    run: (db: Db, context: RequestContext, input: z.infer<S>, call: Call) => Promise<unknown>,
    options: { status?: number; optionalBody?: boolean; allowPendingDeletion?: boolean } = {},
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
        options.allowPendingDeletion,
      );
      return json(result.status, result.body, result.replayed ? { 'idempotent-replayed': 'true' } : {});
    };
  }

  /** Stored idempotent answers stay small: the rows can always be read back. */
  const summaryOf = ({ rows: _rows, ...summary }: Awaited<ReturnType<typeof imports.getImport>>) => summary;

  /** An action on an existing object, with no body (void, restore, unlock, archive): Idem, 200. */
  const ACTION = { status: 200, optionalBody: true };
  const statusAction = (action: 'void' | 'restore') =>
    idempotentWrite(schemas.emptyBody, (db, context, _input, call) => services.changeStatus(db, context, call.params.id!, action), ACTION);

  /** A file sent with a form. Limits come first: BR-16.8 allows 5 MB, and nothing about the file is kept. */
  async function readUpload(call: Call) {
    const tooLarge = () => new ApiError(413, 'IMPORT_TOO_LARGE', 'A file can be at most 5 MB (BR-16.8)');
    if (Number(call.request.headers.get('content-length') ?? 0) > IMPORT_MAX_BYTES + 64 * 1024) throw tooLarge();
    const form = await call.request.formData().catch(() => {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Send the file as multipart/form-data');
    });
    const file = form.get('file');
    if (!(file instanceof File)) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a file');
    if (file.size > IMPORT_MAX_BYTES) throw tooLarge();
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' && value !== '' ? value : undefined;
    };
    const settings = text('settings');
    let parsed: unknown = {};
    try {
      parsed = settings ? JSON.parse(settings) : {};
    } catch {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The settings are not valid JSON');
    }
    return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name || null, settings: parsed, text };
  }

  const routes: Route[] = [
    {
      method: 'POST',
      pattern: /^\/api\/v1\/imports\/preview$/,
      handler: async (call) => {
        const upload = await readUpload(call);
        return json(200, imports.previewFile(upload.bytes, schemas.previewSettings.parse(upload.settings)));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/imports$/,
      handler: async (call) => {
        const key = call.request.headers.get('idempotency-key');
        if (!key || key.length < 8 || key.length > 200) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header of 8 to 200 characters');
        const upload = await readUpload(call);
        const settings = schemas.importSettings.parse(upload.settings);
        const accountId = schemas.id.parse(upload.text('accountId'));
        const saveProfileAs = upload.text('saveProfileAs')?.trim().slice(0, 100);
        const hash = await requestHash('POST', call.url.pathname, { file: imports.sha256(upload.bytes), settings, accountId, saveProfileAs });
        const result = await inWorkspace(
          call.userId,
          (db, context) =>
            idempotent(db, { userId: context.userId, workspaceId: context.workspaceId, key, requestHash: hash }, async () => {
              const { rows: _rows, ...summary } = await imports.createBatch(db, context, { bytes: upload.bytes, fileName: upload.fileName, accountId, settings, saveProfileAs });
              return { status: 201, body: summary };
            }),
          true,
        );
        return json(result.status, result.body, result.replayed ? { 'idempotent-replayed': 'true' } : {});
      },
    },
    { method: 'GET', pattern: /^\/api\/v1\/payees$/, handler: async (call) => json(200, { items: await inWorkspace(call.userId, catalog.getPayees) }) },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/api/v1/payees/${UUID}$`),
      handler: async (call) => {
        const version = requiredVersion(call.request);
        const input = schemas.updatePayeeBody.parse(await readJson(call.request));
        return json(200, await inWorkspace(call.userId, (db, context) => catalog.changePayee(db, context, call.params.id!, version, input), true));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/payees/${UUID}/merge$`),
      handler: idempotentWrite(schemas.mergePayeeBody, (db, context, input, call) => catalog.mergePayees(db, context, call.params.id!, input.intoId), { status: 200 }),
    },
    { method: 'GET', pattern: /^\/api\/v1\/imports$/, handler: async (call) => json(200, { items: await inWorkspace(call.userId, imports.listImports) }) },
    { method: 'GET', pattern: /^\/api\/v1\/import-profiles$/, handler: async (call) => json(200, { items: await inWorkspace(call.userId, imports.getProfiles) }) },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/v1/imports/${UUID}$`),
      handler: async (call) => json(200, await inWorkspace(call.userId, (db, context) => imports.getImport(db, context, call.params.id!))),
    },
    {
      method: 'PATCH',
      pattern: new RegExp(`^/api/v1/imports/${UUID}/rows$`),
      handler: async (call) => {
        const version = requiredVersion(call.request);
        const input = schemas.importDecisionsBody.parse(await readJson(call.request));
        return json(200, await inWorkspace(call.userId, (db, context) => imports.decideRows(db, context, call.params.id!, version, input), true));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/imports/${UUID}/confirm$`),
      handler: idempotentWrite(schemas.importConfirmBody, async (db, context, input, call) => summaryOf(await imports.confirmImport(db, context, call.params.id!, input)), ACTION),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/v1/imports/${UUID}/undo$`),
      handler: idempotentWrite(schemas.importUndoBody, async (db, context, input, call) => summaryOf(await imports.undoImport(db, context, call.params.id!, input)), ACTION),
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/api/v1/imports/${UUID}$`),
      handler: async (call) => json(200, await inWorkspace(call.userId, (db, context) => imports.discardImport(db, context, call.params.id!), true)),
    },
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
      handler: async (call) => json(200, services.workspaceDto(await inWorkspace(call.userId, (db, context) => getWorkspace(db, context.workspaceId), false, true))),
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
        const query = schemas.transactionsQuery.parse(Object.fromEntries(call.url.searchParams));
        return json(200, await inWorkspace(call.userId, (db, context) => services.listTransactions(db, context, query)));
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
      pattern: /^\/api\/v1\/workspace\/deletion$/,
      handler: async (call) => {
        requireFresh(call);
        const response = await idempotentWrite(schemas.emptyBody, (db, context) => deletion.requestDeletion(db, context), { ...ACTION, allowPendingDeletion: true })(call);
        // §8.6: every session ends. The user signs in again to cancel, and hears about it by email.
        const context = await deps.auth.$context;
        await context.internalAdapter.deleteUserSessions(call.userId);
        await deps.sendEmail?.({ to: call.email, kind: 'deletion-requested', url: `${deps.allowedOrigin}/delete-account` });
        return response;
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/workspace\/deletion\/cancel$/,
      handler: async (call) => {
        requireFresh(call);
        return idempotentWrite(schemas.emptyBody, (db, context) => deletion.cancelDeletion(db, context), { ...ACTION, allowPendingDeletion: true })(call);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v1\/audit$/,
      handler: async (call) => {
        const query = schemas.auditQuery.parse(Object.fromEntries(call.url.searchParams));
        const limit = 50;
        const items = await inWorkspace(call.userId, (db, context) => listAuditEvents(db, { ...context, before: query.before, limit: limit + 1 }));
        return json(200, { items: items.slice(0, limit), nextBefore: items.length > limit ? items[limit - 1]!.id : null });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v1\/exports$/,
      handler: async (call) => {
        requireFresh(call);
        const { password } = schemas.exportBody.parse(await readOptionalJson(call.request));
        const { filename, zip } = await inWorkspace(call.userId, (db, context) => buildExport(db, context, password), true, true);
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
  async function authenticate(request: Request): Promise<{ userId: string; email: string; signedInAt: number; refreshed: string[] }> {
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
    // AD-14: the idle limit of this session. Checked against our own column, because Better Auth
    // has already slid its expiry by the time it returns the session.
    const lastActive = new Date(result.session.lastActiveAt ?? result.session.createdAt).getTime();
    const idleLimit = result.session.keepSignedIn ? SESSION_KEEP_IDLE_SECONDS : SESSION_IDLE_SECONDS;
    const context = await deps.auth.$context;
    if (Date.now() - lastActive > idleLimit * 1000) {
      await context.internalAdapter.deleteSession(result.session.token);
      throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in again');
    }
    if (Date.now() - lastActive > 60_000) await context.internalAdapter.updateSession(result.session.token, { lastActiveAt: new Date() });
    return { userId: result.user.id, email: result.user.email, signedInAt: new Date(result.session.createdAt).getTime(), refreshed: headers.getSetCookie() };
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
    const { userId, email, signedInAt, refreshed } = await authenticate(request);
    const match = route.pattern.exec(url.pathname);
    const params: Record<string, string> = match?.[1] ? { id: match[1] } : {};
    try {
      const response = await route.handler({ request, url, params, userId, email, signedInAt });
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
